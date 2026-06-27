import { and, eq } from "drizzle-orm";
import type { ParsedPaper } from "@reviewarena/shared-types";
import { db } from "../db/client.js";
import { claimChecks, metricScores, papers, reviews } from "../db/schema.js";
import { JudgeClient } from "../clients/judge-client.js";
import { logger } from "../logger.js";

// Backfill ClaimCheck + MetricScore rows. Two entry points:
//
//   scoreOneReview()  — called by the orchestrator the moment a single review
//                       is marked COMPLETED, so judging runs concurrently with
//                       the remaining adapters instead of after them.
//   scorePaper()      — paper-wide re-score, used by the admin endpoint when
//                       a manual re-judge is requested.
//
// Both write delete-then-insert ClaimChecks and upsert MetricScores; they're
// safe to run repeatedly on the same review.

/**
 * Judge one review and persist its ClaimChecks + MetricScores. Throws on
 * judge failure (after retry); callers decide whether to swallow + log.
 */
export async function scoreOneReview(
  reviewId: string,
  structured: unknown,
  paperText: string,
  judge: JudgeClient,
): Promise<void> {
  const text = renderReviewText(structured);
  const judged = await judgeWithRetry(judge, text, paperText);

  // ClaimChecks: clear and rewrite atomically.
  await db.transaction(async (tx) => {
    await tx.delete(claimChecks).where(eq(claimChecks.reviewId, reviewId));
    if (judged.claims.length > 0) {
      await tx.insert(claimChecks).values(
        judged.claims.map((c) => ({
          reviewId,
          claimText: c.claim,
          verdict: c.verdict,
          evidence: c.evidence,
          judgeModel: c.judge_model,
        })),
      );
    }
  });

  // Metrics upsert via insert + ON CONFLICT DO UPDATE. The 8 per-dimension
  // judge scores live in meta on the LLM_JUDGE_OVERALL row rather than as
  // separate metric_kind enum values — the reveal page only ever needs them
  // alongside the overall score, so one jsonb payload is the right grain.
  //
  // review_chars / review_words are recorded so post-hoc analysis can do
  // length-controlled scoring (AlpacaEval-style logistic regression on
  // length to factor out verbosity bias). Free to capture, makes the
  // dataset defensible against "did longer reviews win?" critique.
  const reviewChars = text.length;
  const reviewWords = text.split(/\s+/).filter((w) => w.length > 0).length;
  const claimCount = judged.claims.length;

  const metricRows: Array<{
    kind: "LLM_JUDGE_OVERALL" | "LLM_JUDGE_VERIFIABILITY";
    value: number;
    meta: Record<string, unknown>;
  }> = [
    {
      kind: "LLM_JUDGE_OVERALL",
      value: judged.overall_score,
      meta: {
        judge_model: "gpt-4o-mini",
        dimension_scores: judged.dimension_scores,
        review_chars: reviewChars,
        review_words: reviewWords,
        claim_count: claimCount,
      },
    },
    {
      kind: "LLM_JUDGE_VERIFIABILITY",
      value: judged.verifiability_score,
      meta: {
        judge_model: "gpt-4o-mini",
        claim_count: claimCount,
        review_chars: reviewChars,
        review_words: reviewWords,
      },
    },
  ];
  for (const m of metricRows) {
    await db
      .insert(metricScores)
      .values({
        reviewId,
        kind: m.kind,
        referenceType: "NONE",
        value: m.value,
        meta: m.meta,
      })
      .onConflictDoUpdate({
        target: [metricScores.reviewId, metricScores.kind, metricScores.referenceType],
        set: { value: m.value, meta: m.meta, computedAt: new Date() },
      });
  }
}

/**
 * Paper-wide re-score. Iterates every COMPLETED review and judges each one.
 * Per-review failures are logged and skipped; the batch keeps going.
 */
export async function scorePaper(paperId: string, judge: JudgeClient): Promise<void> {
  const paper = await db.query.papers.findFirst({ where: eq(papers.id, paperId) });
  if (!paper || !paper.parsedStructure) {
    throw new Error(`paper ${paperId} not parsed yet`);
  }
  const parsed = paper.parsedStructure as unknown as ParsedPaper;
  const paperText = renderPaperText(parsed);

  const completed = await db.query.reviews.findMany({
    where: and(eq(reviews.paperId, paperId), eq(reviews.status, "COMPLETED")),
  });

  for (const review of completed) {
    try {
      await scoreOneReview(review.id, review.structured, paperText, judge);
    } catch (err) {
      logger.warn(
        { err, reviewId: review.id, paperId },
        "judge failed after retry; review left without claim checks",
      );
    }
  }
}

// The judge is a remote LLM call; transient failures (rate limits, timeouts,
// the occasional non-JSON response) are the common reason a single review
// silently ends up with no claims. The Python side already retries OpenAI
// itself JUDGE_RETRY_MAX times — this layer retries the *Python service*
// for network-level failures (review-gen restart, bridge timeout, transient
// 5xx). Exponential backoff: 500ms, 1s, 2s, 4s = ~7.5s total before giving up.
async function judgeWithRetry(
  judge: JudgeClient,
  reviewText: string,
  paperText: string,
  attempts = 4,
) {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await judge.judge(reviewText, paperText);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
      }
    }
  }
  throw lastErr;
}

export function renderPaperText(parsed: ParsedPaper): string {
  const parts: string[] = [];
  if (parsed.title) parts.push(`# ${parsed.title}`);
  if (parsed.abstract) parts.push(`Abstract: ${parsed.abstract}`);
  for (const s of parsed.sections) parts.push(`## ${s.heading}\n${s.text}`);
  return parts.join("\n\n");
}

function renderReviewText(structured: unknown): string {
  const r = structured as {
    summary?: string;
    strengths?: string[];
    weaknesses?: string[];
    questions?: string[];
  };
  return [
    r.summary,
    ...(r.strengths ?? []).map((s) => `Strength: ${s}`),
    ...(r.weaknesses ?? []).map((w) => `Weakness: ${w}`),
    ...(r.questions ?? []).map((q) => `Question: ${q}`),
  ]
    .filter(Boolean)
    .join("\n");
}
