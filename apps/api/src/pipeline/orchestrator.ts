import { eq } from "drizzle-orm";
import type { ParsedPaper } from "@reviewarena/shared-types";
import { db } from "../db/client.js";
import { reviews, reviewSystems, type Paper, type ReviewSystem } from "../db/schema.js";
import { ReviewGenClient } from "../clients/review-gen-client.js";
import { JudgeClient } from "../clients/judge-client.js";
import { renderPaperText, scoreOneReview } from "./score-paper.js";
import { logger } from "../logger.js";

// Fan out review generation to every enabled ReviewSystem for a given paper.
// NOT idempotent — each call inserts fresh review rows. We deliberately
// dropped the (paperId, reviewSystemId) unique constraint so the same
// paper can be re-uploaded and get a fresh review pair each time. The
// user wants iteration on scope selection without dedup short-circuits.

export interface GenerateOptions {
  /** Original uploaded PDF bytes. Forwarded only to adapters whose
   *  Python-side `requires_pdf_bytes=True` (MARG). Pass undefined for
   *  arxiv2md uploads — MARG will be skipped for those. */
  pdfBytes?: Buffer;
}

export interface Orchestrator {
  generateAllReviews(
    paper: Paper,
    parsed: ParsedPaper,
    options?: GenerateOptions,
  ): Promise<void>;
  /**
   * For the streaming path: insert pending review rows for the chosen
   * systems WITHOUT calling the model. The browser will trigger each
   * generation by opening an SSE stream to /reviews/stream/:reviewId,
   * which lets us stream tokens straight to the UI as they arrive.
   * Returns the review IDs in the same order as `slugs`.
   */
  precreateReviews(
    paper: Paper,
    slugs: readonly string[],
  ): Promise<Array<{ slug: string; reviewId: string }>>;
}

export function makeOrchestrator(
  client: ReviewGenClient,
  judge?: JudgeClient,
): Orchestrator {
  return {
    async generateAllReviews(paper, parsed, options) {
      const systems = await db.query.reviewSystems.findMany({
        where: eq(reviewSystems.enabled, true),
      });
      // Compute the paper text once and pass it to every generateOne so the
      // judge call inside has it ready without re-rendering N times.
      const paperText = judge ? renderPaperText(parsed) : undefined;

      // Parallel: each adapter is a remote LLM call (independent rate limits)
      // and we want the user's wait time to be max(call) not sum(call). If
      // a local-GPU adapter joins later, gate it behind a concurrency limit
      // here. Each generateOne also fires its own judge call the moment its
      // review is COMPLETED (fire-and-forget), so judging runs concurrently
      // with the remaining adapters instead of waiting for the full batch.
      await Promise.all(
        systems.map((s) =>
          generateOne(paper, parsed, s, client, judge, paperText, options?.pdfBytes),
        ),
      );
    },

    async precreateReviews(paper, slugs) {
      // Streaming path: insert review rows in GENERATING status so the
      // browser can open SSE streams keyed by reviewId. Always inserts
      // fresh rows — every upload gets a new pair, no idempotency on
      // (paper, system). The user wants fresh reviews on every upload.
      if (slugs.length === 0) return [];
      const enabled = await db.query.reviewSystems.findMany({
        where: eq(reviewSystems.enabled, true),
      });
      const bySlug = new Map(enabled.map((s) => [s.slug, s]));
      const out: Array<{ slug: string; reviewId: string }> = [];
      for (const slug of slugs) {
        const system = bySlug.get(slug);
        if (!system) {
          logger.warn({ slug }, "precreateReviews: skipping unknown/disabled slug");
          continue;
        }
        const [created] = await db
          .insert(reviews)
          .values({
            paperId: paper.id,
            reviewSystemId: system.id,
            status: "GENERATING",
          })
          .returning({ id: reviews.id });
        out.push({ slug, reviewId: created!.id });
      }
      return out;
    },
  };
}

async function generateOne(
  paper: Paper,
  parsed: ParsedPaper,
  system: ReviewSystem,
  client: ReviewGenClient,
  judge?: JudgeClient,
  paperText?: string,
  pdfBytes?: Buffer,
): Promise<void> {
  // Fresh-per-upload: always insert a new row. Each upload gets a
  // distinct review, even if the same (paper, system) pair was reviewed
  // before. Removes the cache-once invariant in favor of letting the
  // user iterate (change scope, re-test reviewers) without dedup.
  const [created] = await db
    .insert(reviews)
    .values({
      paperId: paper.id,
      reviewSystemId: system.id,
      status: "GENERATING",
    })
    .returning({ id: reviews.id });
  const reviewId = created!.id;

  try {
    const result = await client.generate(
      system.adapterKey,
      parsed,
      system.config ?? {},
      pdfBytes,
    );
    await db
      .update(reviews)
      .set({
        status: "COMPLETED",
        structured: result.review as unknown as object,
        rawOutput: result.rawOutput,
        generationMs: result.generationMs,
        // FAIRNESS A4 — per-generation token accounting.
        inputTokensSent: result.metrics?.inputTokens ?? null,
        inputTokensConsumed: result.metrics?.inputTokens ?? null,
        contextWindow: result.metrics?.contextWindow ?? null,
        outputTokens: result.metrics?.outputTokens ?? null,
        updatedAt: new Date(),
      })
      .where(eq(reviews.id, reviewId));

    // Fire judging now, in the background. The review is COMPLETED in the DB
    // so /pair can already serve it; judging just populates ClaimChecks +
    // MetricScores that the reveal screen polls for. Running per-review here
    // (rather than after all adapters finish) lets judging overlap with the
    // remaining slow generations — saves ~tens of seconds end-to-end.
    if (judge && paperText) {
      void scoreOneReview(reviewId, result.review, paperText, judge).catch(
        (err) =>
          logger.warn(
            { err, reviewId, paperId: paper.id, adapter: system.adapterKey },
            "judge failed for review; reveal will show no claims",
          ),
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(reviews)
      .set({ status: "FAILED", errorMessage: message, updatedAt: new Date() })
      .where(eq(reviews.id, reviewId));
    // Don't rethrow — one failing adapter shouldn't abort the others.
  }
}
