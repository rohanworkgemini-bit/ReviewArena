import { Router } from "express";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { VoteDimensionSchema } from "@reviewarena/shared-types";
import { db } from "../db/client.js";
import { eloSnapshots, papers, reviewSystems, votes } from "../db/schema.js";

export function leaderboardRouter(): Router {
  const router = Router();

  router.get("/leaderboard", async (req, res, next) => {
    try {
      const dimParse = VoteDimensionSchema.safeParse(req.query.dimension);
      const dimension = dimParse.success ? dimParse.data : null;
      const dimCondition = dimension
        ? eq(eloSnapshots.dimension, dimension)
        : isNull(eloSnapshots.dimension);

      // Latest snapshot per system via DISTINCT ON.
      const latest = await db
        .selectDistinctOn([eloSnapshots.reviewSystemId], {
          reviewSystemId: eloSnapshots.reviewSystemId,
          rating: eloSnapshots.rating,
          ratingCiLow: eloSnapshots.ratingCiLow,
          ratingCiHigh: eloSnapshots.ratingCiHigh,
          voteCount: eloSnapshots.voteCount,
          slug: reviewSystems.slug,
          name: reviewSystems.name,
        })
        .from(eloSnapshots)
        .innerJoin(reviewSystems, eq(reviewSystems.id, eloSnapshots.reviewSystemId))
        .where(and(dimCondition))
        .orderBy(eloSnapshots.reviewSystemId, desc(eloSnapshots.computedAt));

      const entries = [...latest]
        .sort((a, b) => b.rating - a.rating)
        .map((s, i) => ({
          rank: i + 1,
          systemSlug: s.slug,
          systemName: s.name,
          rating: s.rating,
          ratingCiLow: s.ratingCiLow,
          ratingCiHigh: s.ratingCiHigh,
          voteCount: s.voteCount,
        }));

      const [paperCountRow] = await db.select({ c: sql<number>`count(*)::int` }).from(papers);
      const [voteCountRow] = await db.select({ c: sql<number>`count(*)::int` }).from(votes);

      res.json({
        dimension,
        totalPapers: paperCountRow?.c ?? 0,
        totalVotes: voteCountRow?.c ?? 0,
        entries,
        computedAt: new Date().toISOString(),
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
