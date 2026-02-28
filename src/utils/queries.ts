import { db } from "@/db";
import { comparisons, reviews, votes, models } from "@/db/schema";
import { eq, sql, aliasedTable } from "drizzle-orm";

/** Get a random comparison with review texts (model names hidden) */
export async function getRandomComparison() {
    const reviewA = aliasedTable(reviews, "review_a");
    const reviewB = aliasedTable(reviews, "review_b");

    const result = await db
        .select({
            comparison_id: comparisons.id,
            review_a: reviewA.text,
            review_b: reviewB.text,
        })
        .from(comparisons)
        .innerJoin(reviewA, eq(comparisons.reviewAId, reviewA.id))
        .innerJoin(reviewB, eq(comparisons.reviewBId, reviewB.id))
        .orderBy(sql`RANDOM()`)
        .limit(1);

    return result.length > 0 ? result[0] : null;
}

/** Record a vote and return model names */
export async function recordVote(comparisonId: number, winner: "A" | "B" | "tie") {
    const comparison = await db.query.comparisons.findFirst({
        where: eq(comparisons.id, comparisonId),
        with: {
            reviewA: { with: { model: true } },
            reviewB: { with: { model: true } },
        },
    });

    if (!comparison) return null;

    let winnerModelId: string | null = null;
    let loserModelId: string | null = null;
    let isTie = false;

    if (winner === "A") {
        winnerModelId = comparison.reviewA.modelId;
        loserModelId = comparison.reviewB.modelId;
    } else if (winner === "B") {
        winnerModelId = comparison.reviewB.modelId;
        loserModelId = comparison.reviewA.modelId;
    } else {
        isTie = true;
        winnerModelId = comparison.reviewA.modelId;
        loserModelId = comparison.reviewB.modelId;
    }

    await db.insert(votes).values({
        comparisonId,
        winnerModelId,
        loserModelId,
        isTie,
    });

    return {
        model_a: comparison.reviewA.model.name,
        model_b: comparison.reviewB.model.name,
    };
}

/** Get leaderboard: wins = 1 point, ties = 0.5 for each model */
export async function getLeaderboard() {
    const allModels = await db.select().from(models);

    const winCounts = await db
        .select({
            modelId: votes.winnerModelId,
            count: sql<number>`cast(count(*) as integer)`,
        })
        .from(votes)
        .where(eq(votes.isTie, false))
        .groupBy(votes.winnerModelId);

    const tieCounts = await db
        .select({
            modelId: votes.winnerModelId,
            count: sql<number>`cast(count(*) as integer)`,
        })
        .from(votes)
        .where(eq(votes.isTie, true))
        .groupBy(votes.winnerModelId);

    const tieCountsLoser = await db
        .select({
            modelId: votes.loserModelId,
            count: sql<number>`cast(count(*) as integer)`,
        })
        .from(votes)
        .where(eq(votes.isTie, true))
        .groupBy(votes.loserModelId);

    const scoreMap = new Map<string, number>();
    for (const m of allModels) {
        scoreMap.set(m.id, 0);
    }

    for (const row of winCounts) {
        if (row.modelId) {
            scoreMap.set(row.modelId, (scoreMap.get(row.modelId) || 0) + row.count);
        }
    }
    for (const row of tieCounts) {
        if (row.modelId) {
            scoreMap.set(row.modelId, (scoreMap.get(row.modelId) || 0) + row.count * 0.5);
        }
    }
    for (const row of tieCountsLoser) {
        if (row.modelId) {
            scoreMap.set(row.modelId, (scoreMap.get(row.modelId) || 0) + row.count * 0.5);
        }
    }

    const leaderboard = allModels
        .map((m) => ({ model: m.name, votes: scoreMap.get(m.id) || 0 }))
        .sort((a, b) => b.votes - a.votes);

    return leaderboard;
}
