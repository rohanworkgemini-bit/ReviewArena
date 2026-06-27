/**
 * Upload-time pair selection — LMArena pattern.
 *
 * Picks 2 systems from review_systems BEFORE generation starts, so we
 * only spend GPU/API budget on the pair the user will actually see.
 * Same weighting algorithm as `select-pair.ts` (LMArena's
 * fastchat/get_battle_pair), just operating on system rows instead of
 * completed reviews.
 *
 * Returns the chosen pair as slug strings, ready to be passed to
 * `orchestrator.precreateReviews(paper, slugs)`.
 */
import { eq, asc } from "drizzle-orm";
import { db } from "../db/client.js";
import { reviewSystems, votes } from "../db/schema.js";
import { computeElo, DEFAULT_ELO, type Battle } from "../elo/elo.js";
import { selectPair, type SystemForPairing, type SelectedPair } from "./select-pair.js";

/**
 * Select an upload-time pair. Returns the two chosen slugs in stable
 * (A, B) order — caller can shuffle for blinding if desired (the
 * underlying selectPair() already coin-flips internally).
 */
export async function selectUploadPair(
  options: { rng?: () => number } = {},
): Promise<{ slugA: string; slugB: string } | null> {
  // Pull enabled systems with their LMArena tuning knobs.
  const systems = await db.query.reviewSystems.findMany({
    where: eq(reviewSystems.enabled, true),
  });
  if (systems.length < 2) return null;

  // Current Elo (close-rated systems face off) + per-system completed
  // comparison counts (FAIRNESS C3 minimum-exposure floor), both from
  // the same completed-only battle history.
  const { ratings, counts } = await currentEloAndCounts();

  // Each system gets a synthetic reviewId="pending-{slug}" since
  // selectPair() expects per-review identifiers. We never use these
  // IDs downstream — only the slugs survive into the orchestrator.
  const candidates: SystemForPairing[] = systems.map((s) => ({
    systemId: s.id,
    reviewId: `pending-${s.slug}`,
    slug: s.slug,
    rating: ratings.get(s.slug) ?? DEFAULT_ELO.INIT_RATING,
    sampleWeight: s.sampleWeight,
    boost: s.boost,
    outage: s.outage,
    anon: s.anon,
    battleTargets: s.battleTargets,
    battleStrictTargets: s.battleStrictTargets,
    comparisonCount: counts.get(s.slug) ?? 0,
  }));

  const chosen: SelectedPair | null = selectPair(candidates, {
    // No "already seen" penalty at upload time — that's per-session and
    // only meaningful when a paper already has multiple completed pairs.
    rng: options.rng,
  });
  if (!chosen) return null;
  return { slugA: chosen.reviewA.slug, slugB: chosen.reviewB.slug };
}

async function currentEloAndCounts(): Promise<{
  ratings: Map<string, number>;
  counts: Map<string, number>;
}> {
  const history = await db.query.votes.findMany({
    orderBy: asc(votes.createdAt),
    with: {
      reviewA: { with: { reviewSystem: true } },
      reviewB: { with: { reviewSystem: true } },
    },
  });
  const counts = new Map<string, number>();
  const battles: Battle[] = history
    .map((v) => {
      const a = v.reviewA?.reviewSystem?.slug;
      const b = v.reviewB?.reviewSystem?.slug;
      if (!a || !b) return null;
      // FAIRNESS B1 — only completed comparisons count toward ratings AND
      // exposure (a failed generation isn't a real game).
      if (v.reviewA.status !== "COMPLETED" || v.reviewB.status !== "COMPLETED") {
        return null;
      }
      counts.set(a, (counts.get(a) ?? 0) + 1);
      counts.set(b, (counts.get(b) ?? 0) + 1);
      const outcome = v.winner === "A" ? 1 : v.winner === "B" ? 0 : 0.5;
      return { a, b, outcome } as Battle;
    })
    .filter((b): b is Battle => b !== null);
  return { ratings: computeElo(battles, DEFAULT_ELO), counts };
}
