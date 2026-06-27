import { describe, it, expect } from "vitest";
import { selectPair, pairKey, type SystemForPairing } from "../select-pair.js";

function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const sys = (
  id: string,
  rating: number,
  overrides: Partial<SystemForPairing> = {},
): SystemForPairing => ({
  systemId: id,
  reviewId: `rev-${id}`,
  slug: id,
  rating,
  sampleWeight: 1.0,
  boost: false,
  outage: false,
  anon: false,
  battleTargets: [],
  battleStrictTargets: [],
  ...overrides,
});

describe("pairKey", () => {
  it("is order-independent", () => {
    expect(pairKey("a", "b")).toBe(pairKey("b", "a"));
  });
});

describe("selectPair", () => {
  it("returns null with fewer than 2 candidates", () => {
    expect(selectPair([])).toBeNull();
    expect(selectPair([sys("a", 1000)])).toBeNull();
  });

  it("returns the only available pair when there are exactly two systems", () => {
    const result = selectPair([sys("a", 1000), sys("b", 1100)], {
      rng: seededRng(1),
    });
    expect(result).not.toBeNull();
    const ids = [result!.reviewA.systemId, result!.reviewB.systemId].sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("favours close-rated pairs over distant ones", () => {
    const candidates = [sys("a", 1000), sys("b", 1010), sys("c", 2000)];
    const counts = new Map<string, number>();
    const rng = seededRng(123);
    const N = 5000;
    for (let i = 0; i < N; i++) {
      const r = selectPair(candidates, { rng })!;
      const k = pairKey(r.reviewA.systemId, r.reviewB.systemId);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const ab = counts.get(pairKey("a", "b")) ?? 0;
    const ac = counts.get(pairKey("a", "c")) ?? 0;
    const bc = counts.get(pairKey("b", "c")) ?? 0;
    expect(ab).toBeGreaterThan(ac);
    expect(ab).toBeGreaterThan(bc);
    expect(ac).toBeGreaterThan(0);
    expect(bc).toBeGreaterThan(0);
  });

  it("downweights already-seen pairs for the same session", () => {
    const candidates = [sys("a", 1000), sys("b", 1000), sys("c", 1000)];
    const seen = new Set([pairKey("a", "b")]);
    const rng = seededRng(99);
    const N = 3000;
    let abCount = 0;
    let nonAb = 0;
    for (let i = 0; i < N; i++) {
      const r = selectPair(candidates, { alreadySeenPairs: seen, rng })!;
      const k = pairKey(r.reviewA.systemId, r.reviewB.systemId);
      if (k === pairKey("a", "b")) abCount++;
      else nonAb++;
    }
    expect(abCount).toBeLessThan(nonAb);
  });

  it("randomises A/B ordering (~50/50)", () => {
    const candidates = [sys("a", 1000), sys("b", 1000)];
    let aOnLeft = 0;
    const N = 4000;
    const rng = seededRng(2024);
    for (let i = 0; i < N; i++) {
      const r = selectPair(candidates, { rng })!;
      if (r.reviewA.systemId === "a") aOnLeft++;
    }
    expect(aOnLeft).toBeGreaterThan(1900);
    expect(aOnLeft).toBeLessThan(2100);
  });

  it("never returns a pair where A and B are the same system", () => {
    const candidates = [sys("a", 1000), sys("b", 1050), sys("c", 1100)];
    const rng = seededRng(5);
    for (let i = 0; i < 1000; i++) {
      const r = selectPair(candidates, { rng })!;
      expect(r.reviewA.systemId).not.toBe(r.reviewB.systemId);
    }
  });

  describe("LMArena knobs", () => {
    it("boost gives a cold-start system more first-pick exposure", () => {
      // a is boosted, three others are not. With proximity multiplying both
      // sides, equal ratings keep proximity uniform, so boost dominates
      // the first-pick distribution.
      const candidates = [
        sys("a", 1000, { boost: true }),
        sys("b", 1000),
        sys("c", 1000),
        sys("d", 1000),
      ];
      const rng = seededRng(11);
      let aAppearances = 0;
      const N = 4000;
      for (let i = 0; i < N; i++) {
        const r = selectPair(candidates, { rng })!;
        if (r.reviewA.systemId === "a" || r.reviewB.systemId === "a") aAppearances++;
      }
      // Without boost, a appears in ~half the pairs (2/4 systems per pair).
      // With 5× boost on stage-1, a appears noticeably more.
      expect(aAppearances).toBeGreaterThan(N * 0.6);
    });

    it("outage excludes a system from pairs entirely", () => {
      const candidates = [
        sys("a", 1000),
        sys("b", 1000),
        sys("c", 1000, { outage: true }),
      ];
      const rng = seededRng(42);
      for (let i = 0; i < 1000; i++) {
        const r = selectPair(candidates, { rng })!;
        expect(r.reviewA.systemId).not.toBe("c");
        expect(r.reviewB.systemId).not.toBe("c");
      }
    });

    it("returns null when all systems are in outage", () => {
      const candidates = [
        sys("a", 1000, { outage: true }),
        sys("b", 1000, { outage: true }),
      ];
      expect(selectPair(candidates, { rng: seededRng(1) })).toBeNull();
    });

    it("anon-vs-anon pairs are forbidden", () => {
      const candidates = [
        sys("a", 1000, { anon: true }),
        sys("b", 1000, { anon: true }),
        sys("c", 1000),
      ];
      const rng = seededRng(7);
      for (let i = 0; i < 1000; i++) {
        const r = selectPair(candidates, { rng })!;
        const slugs = new Set([r.reviewA.slug, r.reviewB.slug]);
        // c must always be one of the two.
        expect(slugs.has("c")).toBe(true);
      }
    });

    it("strict targets restrict rivals to the whitelist", () => {
      // a only fights b (via strict target). Even though c is rated close
      // to a, c is never picked when a is the chosen system.
      const candidates = [
        sys("a", 1000, { battleStrictTargets: ["b"] }),
        sys("b", 1500),
        sys("c", 1001),
      ];
      const rng = seededRng(17);
      // Force "a always picked first" by zeroing everyone else's stage-1
      // weight (impossible via outage which also blocks rival role, so use
      // sampleWeight=0 — but then they can't be rivals either). Instead,
      // just count: when a is in the pair, the *other* must be b.
      for (let i = 0; i < 2000; i++) {
        const r = selectPair(candidates, { rng })!;
        const slugs = new Set([r.reviewA.slug, r.reviewB.slug]);
        if (slugs.has("a")) {
          expect(slugs.has("b")).toBe(true);
          expect(slugs.has("c")).toBe(false);
        }
      }
    });

    it("strict-target wildcards match", () => {
      const candidates = [
        sys("a", 1000, { battleStrictTargets: ["gpt-*"] }),
        sys("gpt-4", 1000),
        sys("gemini-pro", 1000),
      ];
      const rng = seededRng(33);
      for (let i = 0; i < 1000; i++) {
        const r = selectPair(candidates, { rng })!;
        const slugs = new Set([r.reviewA.slug, r.reviewB.slug]);
        if (slugs.has("a")) {
          expect(slugs.has("gpt-4")).toBe(true);
          expect(slugs.has("gemini-pro")).toBe(false);
        }
      }
    });

    it("battleTargets boosts the listed rival over each other rival", () => {
      // All four systems are equally rated. When a is picked first, b is
      // in battleTargets. LMArena's "0.5 × total / |targets|" formula
      // doesn't make targeted rivals dominate the *sum* of the others,
      // but it does dominate *each* individual non-target — that's the
      // property we actually want to assert.
      const candidates = [
        sys("a", 1000, { battleTargets: ["b"] }),
        sys("b", 1000),
        sys("c", 1000),
        sys("d", 1000),
      ];
      const rng = seededRng(55);
      const counts = { ab: 0, ac: 0, ad: 0 };
      const N = 8000;
      for (let i = 0; i < N; i++) {
        const r = selectPair(candidates, { rng })!;
        const slugs = new Set([r.reviewA.slug, r.reviewB.slug]);
        if (slugs.has("a")) {
          if (slugs.has("b")) counts.ab++;
          else if (slugs.has("c")) counts.ac++;
          else if (slugs.has("d")) counts.ad++;
        }
      }
      expect(counts.ab).toBeGreaterThan(counts.ac);
      expect(counts.ab).toBeGreaterThan(counts.ad);
    });

    it("sampleWeight=0 effectively disables a system", () => {
      const candidates = [
        sys("a", 1000),
        sys("b", 1000),
        sys("c", 1000, { sampleWeight: 0 }),
      ];
      const rng = seededRng(91);
      // c can still appear as a rival when b is chosen... but c also has
      // weight 0 in stage 2 (stageOneWeight). So c never appears at all.
      for (let i = 0; i < 1000; i++) {
        const r = selectPair(candidates, { rng })!;
        expect(r.reviewA.systemId).not.toBe("c");
        expect(r.reviewB.systemId).not.toBe("c");
      }
    });
  });
});
