import { Router } from "express";
import multer from "multer";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { reviewSystems } from "../db/schema.js";
import { db } from "../db/client.js";
import { papers, reviews } from "../db/schema.js";
import type { ReviewGenClient } from "../clients/review-gen-client.js";
import type { JudgeClient } from "../clients/judge-client.js";
import type { Orchestrator } from "../pipeline/orchestrator.js";
import { selectUploadPair } from "../pair/select-upload-pair.js";
import { logger } from "../logger.js";
import type { Config } from "../config.js";
import {
  lengthBandFor,
  normalizeArxivId,
  recordUpload,
  UPLOADS_PER_WINDOW,
} from "./papers-helpers.js";

const MAX_BYTES = 10 * 1024 * 1024;

// In-memory upload buffer. We never persist the PDF to disk — it's hashed
// for dedup, shipped to Marker for parsing, and dropped. The parsed
// structure (sections, refs, abstract) lives in papers.parsedStructure
// jsonb; that's all downstream consumers need.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

export interface PapersDeps {
  reviewGen: ReviewGenClient;
  judge: JudgeClient;
  orchestrator: Orchestrator;
}

export function papersRouter(config: Config, deps: PapersDeps): Router {
  const router = Router();
  const { reviewGen, judge, orchestrator } = deps;
  void config;

  router.post("/papers", upload.single("file"), async (req, res, next) => {
    try {
      if (!recordUpload(req.sessionId)) {
        res.status(429).json({
          error: "TooManyRequests",
          message: `At most ${UPLOADS_PER_WINDOW} uploads per minute per session.`,
        });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: "BadRequest", message: "Multipart field `file` required." });
        return;
      }
      if (req.file.mimetype !== "application/pdf") {
        res.status(400).json({ error: "BadRequest", message: "Only application/pdf accepted." });
        return;
      }

      const userTitle = typeof req.body.title === "string" ? req.body.title : null;
      const pdfBuffer = req.file.buffer;
      const filename = req.file.originalname || "paper.pdf";
      const hash = createHash("sha256").update(pdfBuffer).digest("hex");

      // No dedup. Every upload — even of the same PDF — creates a fresh
      // paper row + a fresh review pair. The user wants iteration: change
      // section selection, re-upload, get new reviews without dedup
      // short-circuits or stale completed rows polluting the picker.
      // contentHash is kept (non-unique) for analytics / "how many times
      // has paper X been reviewed".

      const [created] = await db
        .insert(papers)
        .values({
          contentHash: hash,
          userTitle,
          status: "PARSING",
          uploadedBySessionId: req.sessionId,
        })
        .returning();
      const paper = created!;

      void runPipeline(paper.id, pdfBuffer, filename).catch((err) => {
        req.log?.error?.({ err, paperId: paper.id }, "pipeline crashed");
      });

      res.status(201).json({ paperId: paper.id, status: "PARSING", deduplicated: false });
    } catch (e) {
      next(e);
    }
  });

  // arXiv URL/ID upload path — bypasses Marker, parses via arxiv2md.
  // Body: { url: string, title?: string, systemSlugs?: string[] }
  router.post("/papers/arxiv", async (req, res, next) => {
    try {
      if (!recordUpload(req.sessionId)) {
        res.status(429).json({
          error: "TooManyRequests",
          message: `At most ${UPLOADS_PER_WINDOW} uploads per minute per session.`,
        });
        return;
      }
      const raw = typeof req.body?.url === "string" ? req.body.url : "";
      const arxivId = normalizeArxivId(raw);
      if (!arxivId) {
        res.status(400).json({
          error: "BadRequest",
          message: "`url` must be an arXiv URL or ID (e.g. 2312.00752 or https://arxiv.org/abs/2312.00752).",
        });
        return;
      }
      const userTitle = typeof req.body.title === "string" ? req.body.title : null;

      // No dedup — every arxiv upload creates a fresh paper row + review
      // pair, matching the PDF route. Use a session-scoped hash so the
      // contentHash column is still populated (useful for analytics) but
      // collisions are negligible across uploads.
      const hash = createHash("sha256")
        .update(`arxiv2md:${arxivId}:${req.sessionId ?? ""}:${Date.now()}`)
        .digest("hex");

      const [created] = await db
        .insert(papers)
        .values({
          contentHash: hash,
          userTitle,
          status: "PARSING",
          uploadedBySessionId: req.sessionId,
        })
        .returning();
      const paper = created!;
      void runArxivPipeline(paper.id, arxivId).catch((err) => {
        req.log?.error?.({ err, paperId: paper.id }, "pipeline crashed");
      });
      res.status(201).json({ paperId: paper.id, status: "PARSING", deduplicated: false });
    } catch (e) {
      next(e);
    }
  });

  // Enabled review systems for the /dev playground dropdown. Light
  // projection — slug, name, description.
  router.get("/review-systems", async (_req, res, next) => {
    try {
      const rows = await db.query.reviewSystems.findMany({
        where: eq(reviewSystems.enabled, true),
        columns: { slug: true, name: true, description: true },
      });
      res.json({ systems: rows });
    } catch (e) {
      next(e);
    }
  });

  // /dev "Reviewer Playground" — parse + generate in one shot for a
  // chosen system, return the review (non-streaming). Doesn't touch the
  // papers/reviews tables — pure throwaway call for testing systems.
  // Body: multipart with `file` (PDF) + `systemSlug`, OR JSON
  // {url: arxivUrl, systemSlug}.
  router.post(
    "/reviews/playground",
    upload.single("file"),
    async (req, res, next) => {
      try {
        if (!recordUpload(req.sessionId)) {
          res.status(429).json({
            error: "TooManyRequests",
            message: `At most ${UPLOADS_PER_WINDOW} uploads per minute per session.`,
          });
          return;
        }
        const systemSlug =
          (typeof req.body.systemSlug === "string" ? req.body.systemSlug : "").trim();
        if (!systemSlug) {
          res.status(400).json({ error: "BadRequest", message: "systemSlug required" });
          return;
        }
        const system = await db.query.reviewSystems.findFirst({
          where: eq(reviewSystems.slug, systemSlug),
        });
        if (!system || !system.enabled) {
          res.status(404).json({
            error: "NotFound",
            message: `system '${systemSlug}' not found or disabled`,
          });
          return;
        }

        // Two input paths: PDF multipart OR arxiv URL in JSON-ish body.
        let parsed;
        let pdfBuffer: Buffer | undefined;
        if (req.file) {
          if (req.file.mimetype !== "application/pdf") {
            res.status(400).json({ error: "BadRequest", message: "Only application/pdf accepted." });
            return;
          }
          pdfBuffer = req.file.buffer;
          parsed = await reviewGen.parsePdf(pdfBuffer, req.file.originalname || "paper.pdf");
        } else if (typeof req.body.url === "string" && req.body.url.trim()) {
          const arxivId = normalizeArxivId(req.body.url.trim());
          if (!arxivId) {
            res.status(400).json({
              error: "BadRequest",
              message: "url must be a valid arXiv URL/ID",
            });
            return;
          }
          parsed = await reviewGen.parseArxiv(arxivId);
        } else {
          res.status(400).json({
            error: "BadRequest",
            message: "Provide either a `file` (PDF) or a `url` (arXiv).",
          });
          return;
        }

        const result = await reviewGen.generate(
          system.adapterKey,
          parsed,
          system.config ?? {},
          pdfBuffer,
        );
        res.json({
          system: { slug: system.slug, name: system.name, adapterKey: system.adapterKey },
          paper: {
            title: parsed.title,
            pageCount: parsed.pageCount,
            source: parsed.source,
            canonicalTokens: parsed.canonicalTokens ?? null,
          },
          // Raw model input — exactly what was fed to the model as the user
          // message content. Each adapter prepends its own system prompt
          // (not surfaced here yet) but the user-message payload is identical
          // across systems: the canonical text stamped at parse time.
          canonicalText: parsed.canonicalText ?? null,
          review: result.review,
          rawOutput: result.rawOutput,
          generationMs: result.generationMs,
          metrics: result.metrics ?? null,
        });
      } catch (e) {
        next(e);
      }
    },
  );

  router.get("/papers/:id", async (req, res, next) => {
    try {
      const { id } = req.params;
      const paper = await db.query.papers.findFirst({ where: eq(papers.id, id) });
      if (!paper) {
        res.status(404).json({ error: "NotFound", message: `paper ${id}` });
        return;
      }
      // Counts for the upload-page polling UI. `terminalReviewCount` is the
      // only safe "are we done generating" signal — `reviewCount` ticks up
      // as soon as the orchestrator inserts GENERATING rows (within ms of
      // upload), so it's useless for "ready to navigate to /compare".
      const [completedRow, terminalRow, totalRow, expectedRow] = await Promise.all([
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(reviews)
          .where(and(eq(reviews.paperId, id), eq(reviews.status, "COMPLETED"))),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(reviews)
          .where(
            and(
              eq(reviews.paperId, id),
              inArray(reviews.status, ["COMPLETED", "FAILED"]),
            ),
          ),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(reviews)
          .where(eq(reviews.paperId, id)),
        db
          .select({ c: sql<number>`count(*)::int` })
          .from(reviewSystems)
          .where(eq(reviewSystems.enabled, true)),
      ]);

      // The chosen pair's review IDs + slugs. Browser uses these to open
      // SSE streams (/reviews/stream/:reviewId) for token-level rendering.
      // Empty array until precreateReviews has run (i.e. status=PARSED).
      const pairRows = await db
        .select({
          reviewId: reviews.id,
          slug: reviewSystems.slug,
        })
        .from(reviews)
        .innerJoin(reviewSystems, eq(reviews.reviewSystemId, reviewSystems.id))
        .where(eq(reviews.paperId, id));

      // With the upload-time pair selector, expected = 2 for normal
      // Vote-Mode uploads (we only generate the pair). Fall back to
      // total enabled systems for legacy papers that pre-date the
      // streaming flow (their reviewIds row count differs).
      const expectedForPair = pairRows.length || expectedRow[0]?.c || 0;

      // Pluck section metadata for the scope picker. We don't ship the
      // full text to the browser (canonicalText alone can be 40+ KB) —
      // just enough for the user to choose: heading, level, and a rough
      // length so the picker can show a live token-budget meter.
      const parsedStructure = (paper.parsedStructure ?? null) as
        | { sections?: Array<{ heading?: string; level?: number; text?: string }> }
        | null;
      const sections = (parsedStructure?.sections ?? []).map((s, idx) => ({
        id: idx,
        heading: s.heading ?? "(untitled)",
        level: s.level ?? 2,
        // ~3.6 chars per cl100k_base token (matches review-gen's fallback).
        // Rough but good enough for a live meter.
        approxTokens: Math.ceil((s.text ?? "").length / 3.6),
      }));

      // Surface the chosen selection (if any). The picker can pre-populate
      // from the first review's selection when re-opening the page.
      const firstReviewWithScope = await db.query.reviews.findFirst({
        where: eq(reviews.paperId, id),
      });

      res.json({
        id: paper.id,
        title: paper.userTitle ?? paper.extractedTitle,
        status: paper.status,
        pageCount: paper.pageCount,
        reviewCount: totalRow[0]?.c ?? 0,
        completedReviewCount: completedRow[0]?.c ?? 0,
        terminalReviewCount: terminalRow[0]?.c ?? 0,
        expectedReviewCount: expectedForPair,
        createdAt: paper.createdAt.toISOString(),
        reviewIds: pairRows,
        sections,
        selectedSectionIds: firstReviewWithScope?.selectedSectionIds ?? null,
      });
    } catch (e) {
      next(e);
    }
  });

  // POST /papers/:id/scope — set the user's chosen section subset on all
  // reviews for this paper, before any of them have started generating.
  // Body: { selectedSectionIds: number[] | null }. Null = full paper.
  router.post("/papers/:id/scope", async (req, res, next) => {
    try {
      const { id } = req.params;
      const body = (req.body ?? {}) as { selectedSectionIds?: number[] | null };
      const rawIds = body.selectedSectionIds;
      // Validate: array of nonneg ints OR null. Anything else → 400.
      let normalized: number[] | null;
      if (rawIds === null || rawIds === undefined) {
        normalized = null;
      } else if (Array.isArray(rawIds) && rawIds.every((n) => Number.isInteger(n) && n >= 0)) {
        // Dedup + sort so the stored value is canonical (and matches what
        // review-gen would compute server-side).
        normalized = Array.from(new Set(rawIds)).sort((a, b) => a - b);
      } else {
        res.status(400).json({
          error: "BadRequest",
          message: "selectedSectionIds must be an array of nonneg ints or null",
        });
        return;
      }

      // Refuse to set scope only if a review has actually COMPLETED — at
      // that point the model already saw whatever scope was in effect, and
      // changing it now would silently invalidate the result.
      //
      // Note: precreateReviews() inserts rows as GENERATING even before
      // any stream fires (it's the "row exists, awaiting EventSource"
      // marker). We DO allow scope changes during that window, since the
      // model hasn't actually been called yet. The stream-generate
      // endpoint reads `review.selectedSectionIds` at the moment it
      // fires, so whatever scope is in the DB then is what gets used.
      const completedCount = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(reviews)
        .where(and(eq(reviews.paperId, id), eq(reviews.status, "COMPLETED")));
      if ((completedCount[0]?.c ?? 0) > 0) {
        res.status(409).json({
          error: "Conflict",
          message: "Reviews for this paper have already completed; scope is locked.",
        });
        return;
      }

      const updated = await db
        .update(reviews)
        .set({ selectedSectionIds: normalized, updatedAt: new Date() })
        .where(eq(reviews.paperId, id))
        .returning({ id: reviews.id });

      res.json({ updatedReviewCount: updated.length, selectedSectionIds: normalized });
    } catch (e) {
      next(e);
    }
  });

  async function runPipeline(
    paperId: string,
    pdfBuffer: Buffer,
    filename: string,
  ): Promise<void> {
    try {
      // Chandra (Datalab-hosted) is the only PDF parser. No fallback —
      // if Chandra is unreachable or the PDF is image-only / non-academic,
      // the upload fails loudly (PARSE_FAILED) so the user knows their
      // paper wasn't actually processed.
      const parsed = await reviewGen.parsePdf(pdfBuffer, filename);
      const [updated] = await db
        .update(papers)
        .set({
          status: "PARSED",
          extractedTitle: parsed.title,
          abstract: parsed.abstract,
          authors: parsed.authors,
          pageCount: parsed.pageCount,
          parsedStructure: parsed as unknown as object,
          // FAIRNESS A1/C1 — store the canonical input + length band once.
          canonicalText: parsed.canonicalText ?? null,
          canonicalTokens: parsed.canonicalTokens ?? null,
          fullTokens: parsed.fullTokens ?? null,
          lengthBand: lengthBandFor(parsed.fullTokens ?? null),
          updatedAt: new Date(),
        })
        .where(eq(papers.id, paperId))
        .returning();
      // LMArena-style: pick exactly 2 systems via the weighted Elo-aware
      // pair selector and precreate review rows. The browser opens SSE
      // streams to /reviews/stream/:reviewId which trigger the model
      // calls and forward tokens live.
      const pairSlugs = await resolvePairSlugs();
      await orchestrator.precreateReviews(updated!, pairSlugs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(papers)
        .set({ status: "PARSE_FAILED", errorMessage: message, updatedAt: new Date() })
        .where(eq(papers.id, paperId));
    }
  }

  // arXiv-ID upload path. Sends the URL to the Python service which
  // calls arxiv2md.org and returns a ParsedPaper in the same shape.
  // On failure, marks the paper PARSE_FAILED — same contract as the
  // PDF/Chandra path.
  async function runArxivPipeline(
    paperId: string,
    arxivId: string,
  ): Promise<void> {
    try {
      const parsed = await reviewGen.parseArxiv(arxivId);
      const [updated] = await db
        .update(papers)
        .set({
          status: "PARSED",
          extractedTitle: parsed.title,
          abstract: parsed.abstract,
          authors: parsed.authors,
          pageCount: parsed.pageCount,
          parsedStructure: parsed as unknown as object,
          // FAIRNESS A1/C1 — store the canonical input + length band once.
          canonicalText: parsed.canonicalText ?? null,
          canonicalTokens: parsed.canonicalTokens ?? null,
          fullTokens: parsed.fullTokens ?? null,
          lengthBand: lengthBandFor(parsed.fullTokens ?? null),
          updatedAt: new Date(),
        })
        .where(eq(papers.id, paperId))
        .returning();
      const pairSlugs = await resolvePairSlugs();
      await orchestrator.precreateReviews(updated!, pairSlugs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(papers)
        .set({ status: "PARSE_FAILED", errorMessage: message, updatedAt: new Date() })
        .where(eq(papers.id, paperId));
    }
  }

  // Pick exactly 2 systems via the weighted Elo-aware LMArena pair
  // selector — we only generate those 2, saving ~50% of GPU/API cost
  // compared to fanning out to every enabled system.
  async function resolvePairSlugs(): Promise<readonly string[]> {
    const pair = await selectUploadPair();
    if (!pair) {
      // Fewer than 2 enabled systems — let the orchestrator fan out to
      // whatever it finds (likely 0 or 1) so the failure surfaces
      // honestly as "no reviews generated".
      logger.warn(
        { paperId: "<upload>" },
        "selectUploadPair returned null; orchestrator will use all enabled systems as fallback",
      );
      return [];
    }
    return [pair.slugA, pair.slugB];
  }

  return router;
}

