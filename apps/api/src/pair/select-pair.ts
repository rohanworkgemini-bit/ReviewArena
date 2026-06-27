/**
 * Pair selection for the comparison UI — LMArena-style.
 *
 * Mirrors fastchat/serve/gradio_block_arena_anony.py:get_battle_pair
 * (https://github.com/lm-sys/FastChat). Two-stage weighted sampling:
 *
 *   Stage 1: pick the first system proportional to
 *      sampleWeight × (boost ? 5 : 1)
 *   with outage → weight 0.
 *
 *   Stage 2: pick a rival from the remaining systems, with these filters
 *   and overrides applied in order (each one drops the rival if it fails):
 *      a) same system as stage 1 → drop
 *      b) both stage-1 and rival in anon mode → drop (anon-vs-anon banned)
 *      c) stage-1 has strict targets and rival doesn't match any → drop
 *      d) rival has strict targets and stage-1 doesn't match any → drop
 *      e) if stage-1 has rival in battleTargets → override weight to
 *           0.5 * total_weight / len(battleTargets)
 *         (LMArena's directed-attention boost)
 *      f) sample by remaining weight.
 *
 *   Then a coin-flip swaps A/B for blinding.
 *
 * On top of LMArena's algorithm we keep ReviewArena's:
 *   - Closed-form rating-proximity tie-breaker baked into stage-2 weights
 *     so we still favour close-rated pairs when no operator targets exist.
 *   - Soft seen-pair penalty (multiplier) for the current session.
 *
 * Why not pure proximity any more: with TreeReview / DeepReviewer landing
 * mid-study at INIT_RATING, the operator needs a knob (`boost=true` on
 * those rows) to feed votes to them quickly — proximity alone can't tell
 * "new" from "stable" at the same rating.
 */

export interface SystemForPairing {
  systemId: string;
  reviewId: string;
  /** stable identifier used by battleTargets / strict-targets / anon rules. */
  slug: string;
  rating: number;
  /** Base weight in stage 1. 1.0 neutral, 0 disables. */
  sampleWeight: number;
  /** 5× multiplier for cold-start. */
  boost: boolean;
  /** Excluded entirely (weight 0). */
  outage: boolean;
  /** Anonymous-only — never paired with another anonymous system. */
  anon: boolean;
  /** Slugs of preferred rivals when this system is picked first. */
  battleTargets: readonly string[];
  /** Hard whitelist of allowed rival slugs (patterns with "*" wildcards). */
  battleStrictTargets: readonly string[];
  /** Completed comparisons this system has so far. Used for the
   *  minimum-exposure floor (FAIRNESS C3). Optional — absent ⇒ treated
   *  as 0 (under-exposed) so new systems are favoured. */
  comparisonCount?: number;
}

export interface SelectPairOptions {
  alreadySeenPairs?: ReadonlySet<string>;
  /** Multiplier applied to already-seen pairs. Default 0.1. */
  seenPenalty?: number;
  /** Minimum-exposure floor (FAIRNESS C3): systems with fewer than this
   *  many completed comparisons are up-weighted so none is starved of
   *  games. Default 8. Set 0 to disable. */
  minExposure?: number;
  /** Weight multiplier applied to under-exposed systems. Default 8. */
  underExposureBoost?: number;
  rng?: () => number;
}

export interface SelectedPair {
  reviewA: SystemForPairing;
  reviewB: SystemForPairing;
}

const BOOST_FACTOR = 5; // matches LMArena's get_sample_weight constant

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

/** Effective stage-1 weight: outage, operator boost, and the
 *  minimum-exposure floor (FAIRNESS C3). */
function stageOneWeight(
  s: SystemForPairing,
  minExposure: number,
  underExposureBoost: number,
): number {
  if (s.outage) return 0;
  let w = s.boost ? s.sampleWeight * BOOST_FACTOR : s.sampleWeight;
  // Under-exposed systems are up-weighted until they reach the floor, so
  // no enabled system is starved of games (LMArena boosts new models the
  // same way). Absent count ⇒ 0 ⇒ treated as under-exposed.
  if (minExposure > 0 && (s.comparisonCount ?? 0) < minExposure) {
    w *= underExposureBoost;
  }
  return w;
}

/** Convert an LMArena pattern ("*-mini", "gpt-*") to a regex. */
function patternMatch(slug: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  for (const p of patterns) {
    const rx = new RegExp("^" + p.replace(/\*/g, ".*") + "$");
    if (rx.test(slug)) return true;
  }
  return false;
}

/** Weighted-random index. Returns -1 if all weights are zero. */
function sampleIndex(weights: readonly number[], rng: () => number): number {
  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) return -1;
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

export function selectPair(
  candidates: readonly SystemForPairing[],
  opts: SelectPairOptions = {},
): SelectedPair | null {
  if (candidates.length < 2) return null;
  const rng = opts.rng ?? Math.random;
  const seen = opts.alreadySeenPairs ?? new Set<string>();
  const seenPenalty = opts.seenPenalty ?? 0.1;
  const minExposure = opts.minExposure ?? 8;
  const underExposureBoost = opts.underExposureBoost ?? 8;
  const weightOf = (s: SystemForPairing) =>
    stageOneWeight(s, minExposure, underExposureBoost);

  // ─── Stage 1: pick the first system ──────────────────────────────────────
  const stageOneWeights = candidates.map(weightOf);
  const idxA = sampleIndex(stageOneWeights, rng);
  if (idxA === -1) return null;
  const chosen = candidates[idxA]!;
  const totalStageOne = stageOneWeights.reduce((a, b) => a + b, 0);

  // ─── Stage 2: build the rival pool with LMArena's filters/overrides ──────
  const rivalWeights: number[] = [];
  const rivals: SystemForPairing[] = [];

  for (const rival of candidates) {
    if (rival.systemId === chosen.systemId) continue;
    // (b) anon-vs-anon banned
    if (rival.anon && chosen.anon) continue;
    // (c) chosen has strict targets — rival must match
    if (
      chosen.battleStrictTargets.length > 0 &&
      !patternMatch(rival.slug, chosen.battleStrictTargets)
    ) {
      continue;
    }
    // (d) rival has strict targets — chosen must match
    if (
      rival.battleStrictTargets.length > 0 &&
      !patternMatch(chosen.slug, rival.battleStrictTargets)
    ) {
      continue;
    }

    // Rival base weight reuses the stage-1 outage/boost rule but not the
    // chosen system's boost.
    let weight = weightOf(rival);
    if (weight === 0) continue;

    // (e) battleTargets override — directs attention to specific rivals.
    if (chosen.battleTargets.includes(rival.slug)) {
      weight = (0.5 * totalStageOne) / chosen.battleTargets.length;
    }

    // Closed-form proximity multiplier — preserved from the previous design
    // so we still prefer close-rated pairs absent operator targets.
    const proximity = 1 / (1 + Math.abs(chosen.rating - rival.rating));
    weight *= proximity;

    // Soft seen-pair penalty for the current session.
    if (seen.has(pairKey(chosen.systemId, rival.systemId))) {
      weight *= seenPenalty;
    }

    rivals.push(rival);
    rivalWeights.push(weight);
  }

  if (rivals.length === 0) return null;
  const idxB = sampleIndex(rivalWeights, rng);
  if (idxB === -1) return null;
  const rival = rivals[idxB]!;

  // ─── Coin-flip A/B for blinding ──────────────────────────────────────────
  return rng() < 0.5
    ? { reviewA: chosen, reviewB: rival }
    : { reviewA: rival, reviewB: chosen };
}
