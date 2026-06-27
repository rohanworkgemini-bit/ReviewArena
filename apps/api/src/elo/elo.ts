/**
 * Online Elo + bootstrapped 95% CI.
 *
 * Ported (TypeScript) from LMSYS FastChat, file
 *   fastchat/serve/monitor/rating_systems.py
 *   (Apache 2.0, https://github.com/lm-sys/FastChat)
 *
 * The constants and the per-battle update rule come from FastChat verbatim;
 * only the language and the resampling strategy (Math.random vs numpy.random)
 * differ. We deliberately do not re-derive the Bradley-Terry math.
 *
 * Why K = 4 (and not the classic chess K = 32):
 *   FastChat recomputes ratings over the full vote history rather than
 *   maintaining state incrementally, so the smaller K stops the rating
 *   trajectory from being dominated by the most recent battle. We do the
 *   same: every snapshot starts from INIT_RATING and replays history.
 */

export interface EloConstants {
  K: number;
  BASE: number;
  SCALE: number;
  INIT_RATING: number;
}

export const DEFAULT_ELO: EloConstants = {
  K: 4,
  BASE: 10,
  SCALE: 400,
  INIT_RATING: 1000,
};

export type Outcome = 0 | 0.5 | 1;

export interface Battle {
  /** stable identifier for system A — typically the slug */
  a: string;
  /** stable identifier for system B */
  b: string;
  /** 1 = A won, 0 = B won, 0.5 = tie */
  outcome: Outcome;
}

/**
 * Replay a full history of battles and return the current Elo for each
 * system. Equivalent to FastChat's compute_elo.
 */
export function computeElo(
  battles: readonly Battle[],
  c: EloConstants = DEFAULT_ELO,
): Map<string, number> {
  const alpha = Math.log(c.BASE) / c.SCALE;
  const ratings = new Map<string, number>();

  const ensure = (id: string): number => {
    let r = ratings.get(id);
    if (r === undefined) {
      r = c.INIT_RATING;
      ratings.set(id, r);
    }
    return r;
  };

  for (const { a, b, outcome } of battles) {
    const ra = ensure(a);
    const rb = ensure(b);
    // Logistic expected score for A.
    const probA = 1 / (1 + Math.exp(alpha * (rb - ra)));
    const update = c.K * (outcome - probA);
    ratings.set(a, ra + update);
    ratings.set(b, rb - update);
  }

  return ratings;
}

/**
 * One incremental Elo update for a single battle. Returns the new ratings
 * for both systems. Used by the vote endpoint to compute the eloAfter
 * numbers shown on the reveal screen without re-replaying full history.
 *
 * Note: incremental updates and full-history replay diverge in numerical
 * value because the order matters. The leaderboard always uses full-replay;
 * the reveal screen uses the incremental delta only as a UX hint.
 */
export function incrementalEloUpdate(
  ratingA: number,
  ratingB: number,
  outcome: Outcome,
  c: EloConstants = DEFAULT_ELO,
): { ratingA: number; ratingB: number } {
  const alpha = Math.log(c.BASE) / c.SCALE;
  const probA = 1 / (1 + Math.exp(alpha * (ratingB - ratingA)));
  const update = c.K * (outcome - probA);
  return { ratingA: ratingA + update, ratingB: ratingB - update };
}

/**
 * Bootstrap a 95% CI by resampling battles with replacement and refitting
 * Elo on each resample. Ported from FastChat's compute_bootstrap_elo.
 *
 * Returns, for each system, the median rating plus the 2.5%/97.5%
 * percentile bounds across `rounds` resamples. Systems that never appear
 * in a given resample default to INIT_RATING for that round (matches
 * FastChat behavior via np.full).
 */
export interface BootstrapInterval {
  rating: number;       // median across rounds
  ciLow: number;        // 2.5th percentile
  ciHigh: number;       // 97.5th percentile
  voteCount: number;    // battles involving this system in the original set
}

export function bootstrapEloCI(
  battles: readonly Battle[],
  rounds: number = 100,
  c: EloConstants = DEFAULT_ELO,
  rng: () => number = Math.random,
): Map<string, BootstrapInterval> {
  if (battles.length === 0) {
    return new Map();
  }

  // Discover the full system set up front so a system absent from one
  // resample still gets an INIT_RATING entry in that round (matches
  // FastChat's "np.full(init_rating)" pre-allocation).
  const systems = new Set<string>();
  const voteCount = new Map<string, number>();
  for (const { a, b } of battles) {
    systems.add(a);
    systems.add(b);
    voteCount.set(a, (voteCount.get(a) ?? 0) + 1);
    voteCount.set(b, (voteCount.get(b) ?? 0) + 1);
  }

  // ratings[system] = list of length `rounds`
  const samples = new Map<string, number[]>();
  for (const s of systems) samples.set(s, []);

  for (let round = 0; round < rounds; round++) {
    const resample: Battle[] = new Array(battles.length);
    for (let i = 0; i < battles.length; i++) {
      // Math.floor of [0,1) * n is a uniform integer in [0, n-1].
      const idx = Math.floor(rng() * battles.length);
      resample[i] = battles[idx]!;
    }
    const ratings = computeElo(resample, c);
    for (const s of systems) {
      samples.get(s)!.push(ratings.get(s) ?? c.INIT_RATING);
    }
  }

  const out = new Map<string, BootstrapInterval>();
  for (const [s, arr] of samples) {
    const sorted = [...arr].sort((x, y) => x - y);
    out.set(s, {
      rating: percentile(sorted, 0.5),
      ciLow: percentile(sorted, 0.025),
      ciHigh: percentile(sorted, 0.975),
      voteCount: voteCount.get(s) ?? 0,
    });
  }
  return out;
}

/**
 * Linear-interpolated percentile, matching numpy's default
 * (np.percentile with interpolation="linear"). Used by FastChat
 * via pandas .quantile(0.025) / .quantile(0.975).
 */
export function percentile(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) throw new Error("percentile of empty array");
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const pos = q * (sortedAsc.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = pos - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

/**
 * Expected win probability for A, used by the pair-selection algorithm and
 * by the reveal screen's "your vote agreed/disagreed with the model" hint.
 */
export function expectedScore(
  ratingA: number,
  ratingB: number,
  c: EloConstants = DEFAULT_ELO,
): number {
  const alpha = Math.log(c.BASE) / c.SCALE;
  return 1 / (1 + Math.exp(alpha * (ratingB - ratingA)));
}
