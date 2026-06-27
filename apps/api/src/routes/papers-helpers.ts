// Pure helpers for the /papers routes. Lives separately so the route
// handlers stay focused on HTTP wiring + DB access. Anything stateful
// (in-memory rate limit, sliding-window upload counter) is kept here
// too — single source of truth for these knobs.

/**
 * Pull a canonical arXiv ID out of the messy URL/ID forms users might
 * paste. Mirrors the Python normalizer in
 * services/review-gen/app/parsing/arxiv2md.py so dedup hashes line up.
 * Returns null if the input doesn't look like arXiv.
 */
const ARXIV_ID_RE =
  /(?:arxiv\.org\/(?:abs|pdf|html)\/)?(?<id>\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/i;

export function normalizeArxivId(input: string): string | null {
  const s = (input || "").trim();
  if (!s) return null;
  const cleaned = s
    .replace(/\.pdf(\?.*)?$/i, "")
    .split("?")[0]!
    .split("#")[0]!;
  const m = ARXIV_ID_RE.exec(cleaned);
  if (!m?.groups?.id) return null;
  return m.groups.id.replace(/v\d+$/, "");
}

/**
 * Length banding (FAIRNESS invariant C1) — bucket a paper by its full
 * token count so length can be analysed as a covariate later.
 * Thresholds chosen around the fair input budget (11k): "long" means
 * the paper exceeded what every system was shown, which is exactly the
 * regime where truncation could matter.
 */
export function lengthBandFor(fullTokens: number | null): string | null {
  if (fullTokens == null) return null;
  if (fullTokens < 4000) return "short";
  if (fullTokens <= 11000) return "medium";
  return "long";
}

/**
 * Per-session upload rate limiter — sliding window keyed by sessionId.
 * Anonymous uploads still cost real money (Datalab Chandra + Modal); without
 * this a single page can flood the parser. 10 uploads/min/session is
 * far above any real human pattern and well below abusive.
 */
const UPLOADS_WINDOW_MS = 60_000;
export const UPLOADS_PER_WINDOW = 10;
const uploadHits = new Map<string, number[]>();

export function recordUpload(sessionId: string): boolean {
  const now = Date.now();
  const cutoff = now - UPLOADS_WINDOW_MS;
  const hits = (uploadHits.get(sessionId) ?? []).filter((t) => t > cutoff);
  if (hits.length >= UPLOADS_PER_WINDOW) {
    uploadHits.set(sessionId, hits);
    return false;
  }
  hits.push(now);
  uploadHits.set(sessionId, hits);
  return true;
}
