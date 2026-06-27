import { describe, it, expect } from "vitest";
import {
  computeElo,
  incrementalEloUpdate,
  bootstrapEloCI,
  percentile,
  expectedScore,
  DEFAULT_ELO,
  type Battle,
} from "../elo.js";

// Deterministic LCG so bootstrap CI bounds are reproducible without
// hard-coding a specific RNG implementation.
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("expectedScore", () => {
  it("returns 0.5 for equal ratings", () => {
    expect(expectedScore(1000, 1000)).toBeCloseTo(0.5, 10);
  });

  it("returns the FastChat-canonical 0.76 (≈) for a 200-point gap", () => {
    // P(A wins | R_a - R_b = 200) = 1 / (1 + 10^(-200/400)) = 0.7597...
    expect(expectedScore(1200, 1000)).toBeCloseTo(0.7597469, 5);
  });

  it("is symmetric: P(A) + P(B) = 1", () => {
    const p = expectedScore(1300, 950);
    const q = expectedScore(950, 1300);
    expect(p + q).toBeCloseTo(1, 10);
  });
});

describe("computeElo", () => {
  it("returns empty map for no battles", () => {
    expect(computeElo([])).toEqual(new Map());
  });

  it("starts both systems at INIT_RATING and moves them apart after one win", () => {
    const battles: Battle[] = [{ a: "x", b: "y", outcome: 1 }];
    const r = computeElo(battles);
    const rx = r.get("x")!;
    const ry = r.get("y")!;
    // Expected: equal ratings → probA = 0.5 → update = K * (1 - 0.5) = K/2 = 2
    expect(rx).toBeCloseTo(DEFAULT_ELO.INIT_RATING + DEFAULT_ELO.K / 2, 10);
    expect(ry).toBeCloseTo(DEFAULT_ELO.INIT_RATING - DEFAULT_ELO.K / 2, 10);
    // Total rating is conserved.
    expect(rx + ry).toBeCloseTo(2 * DEFAULT_ELO.INIT_RATING, 10);
  });

  it("ties move equal-rated systems by zero", () => {
    const r = computeElo([{ a: "x", b: "y", outcome: 0.5 }]);
    expect(r.get("x")).toBeCloseTo(DEFAULT_ELO.INIT_RATING, 10);
    expect(r.get("y")).toBeCloseTo(DEFAULT_ELO.INIT_RATING, 10);
  });

  it("conserves total rating across the whole history", () => {
    const battles: Battle[] = [
      { a: "x", b: "y", outcome: 1 },
      { a: "y", b: "z", outcome: 0 },
      { a: "x", b: "z", outcome: 0.5 },
      { a: "z", b: "y", outcome: 1 },
    ];
    const r = computeElo(battles);
    const total = [...r.values()].reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(3 * DEFAULT_ELO.INIT_RATING, 8);
  });

  it("ranks a dominant system above a weak one after many battles", () => {
    const battles: Battle[] = [];
    for (let i = 0; i < 200; i++) {
      battles.push({ a: "strong", b: "weak", outcome: 1 });
    }
    const r = computeElo(battles);
    expect(r.get("strong")!).toBeGreaterThan(r.get("weak")!);
    expect(r.get("strong")! - r.get("weak")!).toBeGreaterThan(100);
  });
});

describe("incrementalEloUpdate", () => {
  it("equals computeElo for a single battle", () => {
    const replay = computeElo([{ a: "x", b: "y", outcome: 1 }]);
    const inc = incrementalEloUpdate(
      DEFAULT_ELO.INIT_RATING,
      DEFAULT_ELO.INIT_RATING,
      1,
    );
    expect(inc.ratingA).toBeCloseTo(replay.get("x")!, 10);
    expect(inc.ratingB).toBeCloseTo(replay.get("y")!, 10);
  });

  it("conserves total rating", () => {
    const { ratingA, ratingB } = incrementalEloUpdate(1200, 950, 0);
    expect(ratingA + ratingB).toBeCloseTo(1200 + 950, 10);
  });
});

describe("percentile", () => {
  it("matches numpy linear interpolation on a known sample", () => {
    // np.percentile([10,20,30,40], [2.5, 50, 97.5])
    //   = array([10.75, 25. , 39.25])
    const data = [10, 20, 30, 40];
    expect(percentile(data, 0.025)).toBeCloseTo(10.75, 6);
    expect(percentile(data, 0.5)).toBeCloseTo(25, 6);
    expect(percentile(data, 0.975)).toBeCloseTo(39.25, 6);
  });
});

describe("bootstrapEloCI", () => {
  it("returns an empty map for no battles", () => {
    expect(bootstrapEloCI([])).toEqual(new Map());
  });

  it("ciLow ≤ rating ≤ ciHigh for every system", () => {
    const battles: Battle[] = [
      { a: "a", b: "b", outcome: 1 },
      { a: "b", b: "c", outcome: 0 },
      { a: "c", b: "a", outcome: 0.5 },
      { a: "a", b: "b", outcome: 1 },
      { a: "b", b: "c", outcome: 1 },
    ];
    const ci = bootstrapEloCI(battles, 200, DEFAULT_ELO, seededRng(42));
    for (const [, iv] of ci) {
      expect(iv.ciLow).toBeLessThanOrEqual(iv.rating);
      expect(iv.rating).toBeLessThanOrEqual(iv.ciHigh);
    }
  });

  it("a dominant system's CI lies entirely above a weak one's CI", () => {
    const battles: Battle[] = [];
    for (let i = 0; i < 500; i++) {
      battles.push({ a: "strong", b: "weak", outcome: 1 });
    }
    const ci = bootstrapEloCI(battles, 200, DEFAULT_ELO, seededRng(7));
    expect(ci.get("strong")!.ciLow).toBeGreaterThan(ci.get("weak")!.ciHigh);
  });

  it("vote counts match how often each system appears in the input", () => {
    const battles: Battle[] = [
      { a: "a", b: "b", outcome: 1 },
      { a: "a", b: "c", outcome: 0 },
      { a: "b", b: "c", outcome: 0.5 },
    ];
    const ci = bootstrapEloCI(battles, 50, DEFAULT_ELO, seededRng(1));
    expect(ci.get("a")!.voteCount).toBe(2);
    expect(ci.get("b")!.voteCount).toBe(2);
    expect(ci.get("c")!.voteCount).toBe(2);
  });
});
