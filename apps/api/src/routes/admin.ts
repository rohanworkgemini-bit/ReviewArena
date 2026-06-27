import { Router } from "express";
import { z } from "zod";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import {
  CreateReviewSystemRequestSchema,
  VOTE_DIMENSIONS,
} from "@reviewarena/shared-types";
import { db } from "../db/client.js";
import { papers, reviews, reviewSystems, votes } from "../db/schema.js";
import { requireAdmin } from "../plugins/admin-auth.js";
import type { JudgeClient } from "../clients/judge-client.js";
import { scorePaper } from "../pipeline/score-paper.js";
import type { ReviewGenClient } from "../clients/review-gen-client.js";
import type { Orchestrator } from "../pipeline/orchestrator.js";
import type { ParsedPaper } from "@reviewarena/shared-types";
import type { Config } from "../config.js";

const UpdateReviewSystemSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
    config: z.record(z.unknown()).optional(),
  })
  .strict();

export interface AdminDeps {
  reviewGen: ReviewGenClient;
  judge: JudgeClient;
  orchestrator: Orchestrator;
}

export function adminRouter(config: Config, deps: AdminDeps): Router {
  const router = Router();
  const guard = requireAdmin(config.ADMIN_TOKEN);
  const { judge, orchestrator: orch } = deps;
  void deps.reviewGen;

  // All admin routes require the bearer token.
  router.use("/admin", guard);

  // ─── Review systems ────────────────────────────────────────────────

  router.get("/admin/review-systems", async (_req, res, next) => {
    try {
      const rows = await db.query.reviewSystems.findMany({
        orderBy: asc(reviewSystems.createdAt),
      });
      res.json(
        rows.map((s) => ({
          id: s.id,
          slug: s.slug,
          name: s.name,
          description: s.description,
          adapterKey: s.adapterKey,
          enabled: s.enabled,
          createdAt: s.createdAt.toISOString(),
        })),
      );
    } catch (e) {
      next(e);
    }
  });

  router.post("/admin/review-systems", async (req, res, next) => {
    try {
      const parse = CreateReviewSystemRequestSchema.safeParse(req.body);
      if (!parse.success) {
        res.status(400).json({
          error: "BadRequest",
          details: parse.error.flatten(),
        });
        return;
      }
      const body = parse.data;
      const [created] = await db
        .insert(reviewSystems)
        .values({
          slug: body.slug,
          name: body.name,
          description: body.description,
          adapterKey: body.adapterKey,
          config: body.config,
        })
        .returning();
      const c = created!;
      res.status(201).json({
        id: c.id,
        slug: c.slug,
        name: c.name,
        description: c.description,
        adapterKey: c.adapterKey,
        enabled: c.enabled,
        createdAt: c.createdAt.toISOString(),
      });
    } catch (e) {
      next(e);
    }
  });

  router.patch("/admin/review-systems/:id", async (req, res, next) => {
    try {
      const parse = UpdateReviewSystemSchema.safeParse(req.body);
      if (!parse.success) {
        res.status(400).json({ error: "BadRequest", details: parse.error.flatten() });
        return;
      }
      const [updated] = await db
        .update(reviewSystems)
        .set({ ...parse.data, updatedAt: new Date() })
        .where(eq(reviewSystems.id, req.params.id))
        .returning();
      res.json(updated);
    } catch (e) {
      next(e);
    }
  });

  // One-click enable/disable. Convenience wrapper over PATCH for the admin
  // UI's toggle button — saves the client a body construction.
  router.post("/admin/review-systems/:id/toggle", async (req, res, next) => {
    try {
      const existing = await db.query.reviewSystems.findFirst({
        where: eq(reviewSystems.id, req.params.id),
      });
      if (!existing) {
        res.status(404).json({ error: "NotFound", message: req.params.id });
        return;
      }
      const [updated] = await db
        .update(reviewSystems)
        .set({ enabled: !existing.enabled, updatedAt: new Date() })
        .where(eq(reviewSystems.id, req.params.id))
        .returning();
      res.json(updated);
    } catch (e) {
      next(e);
    }
  });

  // Delete is allowed only when no Reviews reference this system — Reviews
  // have no ON DELETE CASCADE on `review_system_id` by design (we keep
  // historical votes traceable). Use disable instead of delete for systems
  // that already produced reviews.
  router.delete("/admin/review-systems/:id", async (req, res, next) => {
    try {
      const inUse = await db.query.reviews.findFirst({
        where: eq(reviews.reviewSystemId, req.params.id),
        columns: { id: true },
      });
      if (inUse) {
        res.status(409).json({
          error: "Conflict",
          message:
            "System has existing reviews; disable it instead so historical votes remain valid.",
        });
        return;
      }
      const [deleted] = await db
        .delete(reviewSystems)
        .where(eq(reviewSystems.id, req.params.id))
        .returning({ id: reviewSystems.id });
      if (!deleted) {
        res.status(404).json({ error: "NotFound", message: req.params.id });
        return;
      }
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  // ─── Vote inspection ───────────────────────────────────────────────

  router.get("/admin/votes", async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit ?? 200), 1000);
      const rows = await db.query.votes.findMany({
        orderBy: desc(votes.createdAt),
        limit,
        with: {
          reviewA: { with: { reviewSystem: true } },
          reviewB: { with: { reviewSystem: true } },
          dimensions: true,
        },
      });
      res.json(rows);
    } catch (e) {
      next(e);
    }
  });

  // ─── Regenerate stuck reviews ──────────────────────────────────────

  // Deletes any non-COMPLETED reviews for the paper and re-runs the
  // generation pipeline. Recovers from API restarts that orphaned
  // GENERATING rows mid-flight.
  router.post("/admin/papers/:id/regenerate", async (req, res, next) => {
    try {
      const paper = await db.query.papers.findFirst({
        where: eq(papers.id, req.params.id),
      });
      if (!paper) {
        res.status(404).json({ error: "NotFound", message: req.params.id });
        return;
      }
      if (!paper.parsedStructure) {
        res.status(400).json({
          error: "NotParsed",
          message: "Paper hasn't been parsed yet — re-upload it.",
        });
        return;
      }
      // Drop everything except COMPLETED so we don't re-run successful
      // generations and incur the cost.
      const deleted = await db
        .delete(reviews)
        .where(and(eq(reviews.paperId, paper.id), ne(reviews.status, "COMPLETED")))
        .returning({ id: reviews.id });
      // Fire-and-forget so the response returns immediately.
      void orch
        .generateAllReviews(paper, paper.parsedStructure as unknown as ParsedPaper)
        .catch((err) => req.log?.error?.({ err }, "regenerate crashed"));
      res.json({
        ok: true,
        paperId: paper.id,
        dropped: deleted.length,
        message: "Generation re-dispatched. Poll GET /papers/:id for progress.",
      });
    } catch (e) {
      next(e);
    }
  });

  // ─── Score paper (Checkpoint 7 backfill trigger) ───────────────────

  router.post("/admin/papers/:id/score", async (req, res, next) => {
    try {
      await scorePaper(req.params.id, judge);
      res.json({ ok: true, paperId: req.params.id });
    } catch (e) {
      next(e);
    }
  });

  // ─── Exports for thesis analysis ───────────────────────────────────

  router.get("/admin/export.json", async (_req, res, next) => {
    try {
      const [systems, paperRows, voteRows, metricRows, claimRows, snapshotRows] = await Promise.all([
        db.query.reviewSystems.findMany(),
        db.query.papers.findMany({ with: { reviews: true } }),
        db.query.votes.findMany({ with: { dimensions: true } }),
        db.query.metricScores.findMany(),
        db.query.claimChecks.findMany(),
        db.query.eloSnapshots.findMany(),
      ]);
      res
        .setHeader("content-disposition", `attachment; filename=reviewarena-export-${Date.now()}.json`)
        .json({
          exportedAt: new Date().toISOString(),
          systems,
          papers: paperRows,
          votes: voteRows,
          metrics: metricRows,
          claims: claimRows,
          snapshots: snapshotRows,
        });
    } catch (e) {
      next(e);
    }
  });

  router.get("/admin/export.csv", async (_req, res, next) => {
    try {
      // Long format: one row per vote with dimension ratings flattened.
      const voteRows = await db.query.votes.findMany({
        orderBy: asc(votes.createdAt),
        with: {
          reviewA: { with: { reviewSystem: true } },
          reviewB: { with: { reviewSystem: true } },
          dimensions: true,
        },
      });
      const header = [
        "vote_id",
        "created_at",
        "session_id",
        "paper_id",
        "system_a",
        "system_b",
        "winner",
        "decision_ms",
        ...VOTE_DIMENSIONS.map((d) => `dim_${d.toLowerCase()}`),
      ].join(",");
      const rows = voteRows.map((v) => {
        const dimMap = new Map(v.dimensions.map((d) => [d.dimension, d.value]));
        return [
          v.id,
          v.createdAt.toISOString(),
          v.sessionId,
          v.paperId,
          v.reviewA.reviewSystem.slug,
          v.reviewB.reviewSystem.slug,
          v.winner,
          v.decisionMs ?? "",
          ...VOTE_DIMENSIONS.map((d) => dimMap.get(d) ?? ""),
        ].join(",");
      });
      res
        .setHeader("content-type", "text/csv")
        .setHeader("content-disposition", `attachment; filename=reviewarena-votes-${Date.now()}.csv`)
        .send([header, ...rows].join("\n"));
    } catch (e) {
      next(e);
    }
  });

  return router;
}
