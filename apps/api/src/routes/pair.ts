import { Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { papers, reviews, reviewSystems, votes } from "../db/schema.js";
import { selectPair, pairKey, type SystemForPairing } from "../pair/select-pair.js";
import { computeElo, DEFAULT_ELO, type Battle } from "../elo/elo.js";
import type { Config } from "../config.js";

// pairToken: HMAC over (paperId, reviewAId, reviewBId, sessionId, iat) so
// the vote endpoint can trust the A/B mapping without server-side pair
// state. Carries an issued-at + expiry to prevent replay of stale tokens.

const PAIR_TOKEN_TTL_SECONDS = 60 * 60; // 1h — generous for a single round.

export interface PairTokenPayload {
  paperId: string;
  reviewAId: string;
  reviewBId: string;
  sessionId: string;
  iat: number; // unix seconds at signing time
}

interface SignedBody {
  p: string; // paperId
  a: string; // reviewAId
  b: string; // reviewBId
  s: string; // sessionId
  t: number; // iat (unix seconds)
}

export function signPairToken(
  payload: Omit<PairTokenPayload, "iat"> & { iat?: number },
  secret: string,
): string {
  const iat = payload.iat ?? Math.floor(Date.now() / 1000);
  const body: SignedBody = {
    p: payload.paperId,
    a: payload.reviewAId,
    b: payload.reviewBId,
    s: payload.sessionId,
    t: iat,
  };
  const bodyJson = JSON.stringify(body);
  const mac = createHmac("sha256", secret).update(bodyJson).digest("base64url");
  return `${Buffer.from(bodyJson, "utf8").toString("base64url")}.${mac}`;
}

export function verifyPairToken(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): PairTokenPayload | null {
  const [b64, mac] = token.split(".");
  if (!b64 || !mac) return null;

  let bodyJson: string;
  try {
    bodyJson = Buffer.from(b64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", secret).update(bodyJson).digest("base64url");

  // Constant-time compare against a fixed-length buffer so the timing
  // signal does not differentiate "right length / wrong bytes" from
  // "wrong length".
  const macBuf = Buffer.from(mac, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  const padded = Buffer.alloc(expectedBuf.length);
  macBuf.copy(padded, 0, 0, Math.min(macBuf.length, expectedBuf.length));
  if (!timingSafeEqual(padded, expectedBuf)) return null;
  if (macBuf.length !== expectedBuf.length) return null;

  let parsed: SignedBody;
  try {
    parsed = JSON.parse(bodyJson) as SignedBody;
  } catch {
    return null;
  }
  if (
    typeof parsed.p !== "string" ||
    typeof parsed.a !== "string" ||
    typeof parsed.b !== "string" ||
    typeof parsed.s !== "string" ||
    typeof parsed.t !== "number"
  ) {
    return null;
  }

  // Expiry: token is good for PAIR_TOKEN_TTL_SECONDS. Clock skew tolerance
  // of +60s on the future side so a freshly-signed token from a slightly
  // ahead host doesn't get rejected.
  if (parsed.t > now + 60) return null;
  if (parsed.t + PAIR_TOKEN_TTL_SECONDS < now) return null;

  return {
    paperId: parsed.p,
    reviewAId: parsed.a,
    reviewBId: parsed.b,
    sessionId: parsed.s,
    iat: parsed.t,
  };
}

export function pairRouter(config: Config): Router {
  const router = Router();

  router.get("/pair", async (req, res, next) => {
    try {
      const paperId = typeof req.query.paperId === "string" ? req.query.paperId : "";
      if (paperId.length < 20) {
        res.status(400).json({ error: "BadRequest", message: "paperId is required." });
        return;
      }

      const paper = await db.query.papers.findFirst({ where: eq(papers.id, paperId) });
      if (!paper) {
        res.status(404).json({ error: "NotFound", message: `paper ${paperId}` });
        return;
      }

      // With the upload-time pair selector (precreateReviews), the paper
      // already has exactly 2 review rows for the chosen pair. They may
      // still be GENERATING — that's fine, the browser opens SSE streams
      // to /reviews/stream/:reviewId for token-level rendering and only
      // needs the pairToken now. We accept GENERATING and COMPLETED rows
      // here; FAILED/PENDING are skipped.
      const enabled = await db.query.reviewSystems.findMany({
        where: eq(reviewSystems.enabled, true),
        columns: { id: true },
      });
      const enabledIds = enabled.map((s) => s.id);
      const allReviews = enabledIds.length
        ? await db.query.reviews.findMany({
            where: and(eq(reviews.paperId, paperId), inArray(reviews.reviewSystemId, enabledIds)),
            with: { reviewSystem: true },
          })
        : [];
      const eligible = allReviews.filter(
        (r) => r.status === "GENERATING" || r.status === "COMPLETED",
      );
      if (eligible.length < 2) {
        res.status(404).json({
          error: "NotReady",
          message: `paper ${paperId} only has ${eligible.length} completed review(s).`,
        });
        return;
      }

      // ─── Resume an in-flight round ───────────────────────────────────────
      // LMArena semantics: a pair is locked from the moment the user starts
      // the round until they vote. Refreshing the page should keep showing
      // the same pair — otherwise the user thinks "let me re-read review A"
      // and is surprised by a different one. The frontend persists the
      // pairToken in sessionStorage and sends it back here on every reload.
      const resumeTokenRaw = req.query.pairToken;
      if (typeof resumeTokenRaw === "string" && resumeTokenRaw.length > 0) {
        const decoded = verifyPairToken(resumeTokenRaw, config.PAIR_TOKEN_SECRET);
        if (
          decoded &&
          decoded.paperId === paperId &&
          decoded.sessionId === req.sessionId
        ) {
          const reviewA = eligible.find((r) => r.id === decoded.reviewAId);
          const reviewB = eligible.find((r) => r.id === decoded.reviewBId);
          if (reviewA && reviewB) {
            res.json({
              paper: {
                id: paper.id,
                title: paper.userTitle ?? paper.extractedTitle,
              },
              reviewA: { reviewId: reviewA.id, structured: reviewA.structured },
              reviewB: { reviewId: reviewB.id, structured: reviewB.structured },
              pairToken: resumeTokenRaw,
            });
            return;
          }
        }
        // Token was malformed, expired, for a different session, or pointed
        // at reviews that have since been deleted. Fall through to fresh
        // selection — silent recovery rather than 4xx.
      }

      const currentRatings = await currentEloMap();
      const candidates: SystemForPairing[] = eligible.map((r) => ({
        systemId: r.reviewSystemId,
        reviewId: r.id,
        slug: r.reviewSystem.slug,
        rating: currentRatings.get(r.reviewSystem.slug) ?? DEFAULT_ELO.INIT_RATING,
        sampleWeight: r.reviewSystem.sampleWeight,
        boost: r.reviewSystem.boost,
        outage: r.reviewSystem.outage,
        anon: r.reviewSystem.anon,
        battleTargets: r.reviewSystem.battleTargets,
        battleStrictTargets: r.reviewSystem.battleStrictTargets,
      }));

      const seenVotes = await db.query.votes.findMany({
        where: and(eq(votes.paperId, paperId), eq(votes.sessionId, req.sessionId)),
        with: { reviewA: true, reviewB: true },
      });
      const alreadySeen = new Set(
        seenVotes.map((v) => pairKey(v.reviewA.reviewSystemId, v.reviewB.reviewSystemId)),
      );

      const chosen = selectPair(candidates, { alreadySeenPairs: alreadySeen });
      if (!chosen) {
        res.status(404).json({ error: "Exhausted", message: "No new pairs for this session." });
        return;
      }

      const reviewA = eligible.find((r) => r.id === chosen.reviewA.reviewId)!;
      const reviewB = eligible.find((r) => r.id === chosen.reviewB.reviewId)!;

      const token = signPairToken(
        { paperId, reviewAId: reviewA.id, reviewBId: reviewB.id, sessionId: req.sessionId },
        config.PAIR_TOKEN_SECRET,
      );

      // For streaming flow: when a review is still GENERATING, structured
      // is null. The browser detects this and opens an SSE stream to
      // /reviews/stream/:reviewId to receive tokens live. Once both
      // streams complete the user can vote (vote bar guards on this).
      res.json({
        paper: {
          id: paper.id,
          title: paper.userTitle ?? paper.extractedTitle,
        },
        reviewA: {
          reviewId: reviewA.id,
          structured: reviewA.structured ?? null,
          status: reviewA.status,
        },
        reviewB: {
          reviewId: reviewB.id,
          structured: reviewB.structured ?? null,
          status: reviewB.status,
        },
        pairToken: token,
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

async function currentEloMap(): Promise<Map<string, number>> {
  const history = await db.query.votes.findMany({
    orderBy: asc(votes.createdAt),
    with: {
      reviewA: { with: { reviewSystem: true } },
      reviewB: { with: { reviewSystem: true } },
    },
  });
  // FAIRNESS B1 — pairing ratings use only completed comparisons, matching
  // the leaderboard's exclusion of infra failures.
  const battles: Battle[] = history
    .filter(
      (v) =>
        v.reviewA.status === "COMPLETED" && v.reviewB.status === "COMPLETED",
    )
    .map((v) => ({
      a: v.reviewA.reviewSystem.slug,
      b: v.reviewB.reviewSystem.slug,
      outcome: v.winner === "A" ? 1 : v.winner === "B" ? 0 : 0.5,
    }));
  return computeElo(battles);
}
