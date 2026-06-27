import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { votes, type ClaimCheck, type MetricScore } from "../db/schema.js";

// GET /reveal/:voteId — paper-grounded ClaimCheck rows + LLM-judge scores
// (overall + per-dimension) for both reviews. Populated by
// /admin/papers/:id/score (Checkpoint 7) — empty arrays if scoring hasn't
// run yet.

export function revealRouter(): Router {
  const router = Router();

  router.get("/reveal/:voteId", async (req, res, next) => {
    try {
      const { voteId } = req.params;
      const vote = await db.query.votes.findFirst({
        where: eq(votes.id, voteId),
        with: {
          reviewA: {
            with: { reviewSystem: true, claimChecks: true, metricScores: true },
          },
          reviewB: {
            with: { reviewSystem: true, claimChecks: true, metricScores: true },
          },
        },
      });
      if (!vote) {
        res.status(404).json({ error: "NotFound", message: voteId });
        return;
      }

      type ReviewSide = NonNullable<typeof vote>["reviewA"];
      const pack = (review: ReviewSide) => {
        const supported = review.claimChecks.filter(
          (c: ClaimCheck) => c.verdict === "SUPPORTED",
        ).length;
        const overallRow = review.metricScores.find(
          (m: MetricScore) => m.kind === "LLM_JUDGE_OVERALL",
        );
        const verifiabilityRow = review.metricScores.find(
          (m: MetricScore) => m.kind === "LLM_JUDGE_VERIFIABILITY",
        );
        const dimensionScores =
          (overallRow?.meta as { dimension_scores?: Record<string, number> } | null)
            ?.dimension_scores ?? null;
        return {
          reviewId: review.id,
          systemName: review.reviewSystem.name,
          claims: review.claimChecks.map((c: ClaimCheck) => ({
            claim: c.claimText,
            verdict: c.verdict,
            evidence: c.evidence,
            judgeModel: c.judgeModel,
          })),
          verifiabilityFraction:
            review.claimChecks.length > 0 ? supported / review.claimChecks.length : 0,
          judgeOverall: overallRow?.value ?? null,
          judgeVerifiability: verifiabilityRow?.value ?? null,
          judgeDimensions: dimensionScores,
        };
      };

      res.json({ reviewA: pack(vote.reviewA), reviewB: pack(vote.reviewB) });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
