// SSE bridge: streams review tokens from review-gen to the browser
// and persists the final state to DB. The browser opens this endpoint
// for each reviewId in the chosen pair after upload. Idempotent — a
// re-open on an already-COMPLETED review replays the raw output as a
// single token + done event.
//
// Split out of routes/papers.ts so the upload path stays focused on
// HTTP+DB plumbing and this file owns the streaming machinery.

import { Router } from "express";
import { eq } from "drizzle-orm";
import { reviews } from "../db/schema.js";
import { db } from "../db/client.js";
import type { ReviewGenClient } from "../clients/review-gen-client.js";
import type { JudgeClient } from "../clients/judge-client.js";
import { renderPaperText, scoreOneReview } from "../pipeline/score-paper.js";

export interface ReviewsStreamDeps {
  reviewGen: ReviewGenClient;
  judge: JudgeClient;
}

// In-memory mutex per reviewId. At most one /reviews/stream/:reviewId
// handler may be invoking the model for a given reviewId; a second
// opener awaits the first then replays the now-terminal state. Per-
// process (fine for thesis-scale single-replica). For a multi-instance
// fleet, swap for a Postgres advisory lock.
const inFlightStreams = new Map<string, Promise<void>>();

export function reviewsStreamRouter(deps: ReviewsStreamDeps): Router {
  const router = Router();
  const { reviewGen, judge } = deps;

  router.get("/reviews/stream/:reviewId", async (req, res) => {
    const { reviewId } = req.params;

    const sendHeaders = () => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();
    };
    const sse = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const review = await db.query.reviews.findFirst({
      where: eq(reviews.id, reviewId),
      with: { reviewSystem: true, paper: true },
    });
    if (!review) {
      res.status(404).json({ error: "NotFound", message: `review ${reviewId}` });
      return;
    }

    // Replay path for already-COMPLETED reviews (browser reconnect /
    // refresh): emit raw output as a single token + done event. No auth
    // check — completed reviews are public read-only state.
    if (review.status === "COMPLETED" && review.structured) {
      sendHeaders();
      sse("token", { text: review.rawOutput ?? "" });
      sse("done", {
        review: review.structured,
        raw_output: review.rawOutput ?? "",
        generation_ms: review.generationMs ?? 0,
      });
      res.end();
      return;
    }
    if (review.status === "FAILED") {
      sendHeaders();
      sse("error", { message: review.errorMessage ?? "Generation failed" });
      res.end();
      return;
    }

    // AUTH: only the uploader may trigger live generation. The replay
    // branch above (COMPLETED / FAILED) intentionally has no check —
    // finished reviews are public read-only state, which is what lets
    // other voters view + vote on the same paper. But the live path
    // below invokes the model (billable) and streams partial output, so
    // restrict it to the session that uploaded the paper. Legacy rows
    // with no uploadedBySessionId are permitted (pre-column uploads).
    const uploaderSid = review.paper?.uploadedBySessionId;
    if (uploaderSid && uploaderSid !== req.sessionId) {
      res.status(403).json({
        error: "Forbidden",
        message: "Only the uploading session can trigger live generation",
      });
      return;
    }

    // Generation cost is already bounded: precreateReviews allocated
    // exactly the reviewIds for this paper at upload time, and the
    // per-reviewId mutex below prevents two simultaneous openers from
    // double-firing the model.
    const paperStructure = review.paper?.parsedStructure;
    if (!paperStructure) {
      sendHeaders();
      sse("error", { message: "Paper parsed structure missing — re-upload required" });
      res.end();
      return;
    }

    // Single-flight per reviewId. If another request is already invoking
    // the model for this reviewId, wait for it; then short-circuit to
    // the COMPLETED replay branch (or surface the error it landed on).
    const existing = inFlightStreams.get(reviewId);
    if (existing) {
      try {
        await existing;
      } catch {
        /* primary handler already wrote FAILED — fall through */
      }
      const final = await db.query.reviews.findFirst({
        where: eq(reviews.id, reviewId),
      });
      sendHeaders();
      if (final?.status === "COMPLETED" && final.structured) {
        sse("token", { text: final.rawOutput ?? "" });
        sse("done", {
          review: final.structured,
          raw_output: final.rawOutput ?? "",
          generation_ms: final.generationMs ?? 0,
        });
      } else {
        sse("error", { message: final?.errorMessage ?? "primary stream failed" });
      }
      res.end();
      return;
    }

    sendHeaders();

    // Browser-disconnect → abort upstream. Without this the model keeps
    // generating tokens nobody is reading, on a billed GPU.
    const abortController = new AbortController();
    const onClose = () => abortController.abort();
    req.on("close", onClose);

    if (review.status !== "GENERATING") {
      await db
        .update(reviews)
        .set({ status: "GENERATING", errorMessage: null, updatedAt: new Date() })
        .where(eq(reviews.id, review.id));
    }

    const work = (async () => {
      let accumulated = "";
      const startedAt = Date.now();
      let firstTokenMs: number | null = null;
      try {
        const stream = reviewGen.streamGenerate(
          review.reviewSystem.adapterKey,
          paperStructure as unknown as Parameters<typeof reviewGen.streamGenerate>[1],
          review.reviewSystem.config ?? {},
          undefined,
          abortController.signal,
          review.selectedSectionIds ?? null,
        );
        for await (const evt of stream) {
          if (evt.kind === "token") {
            if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
            accumulated += evt.text;
            sse("token", { text: evt.text });
          } else if (evt.kind === "done") {
            await db
              .update(reviews)
              .set({
                status: "COMPLETED",
                structured: evt.review as unknown as object,
                rawOutput: evt.rawOutput,
                generationMs: evt.generationMs,
                // FAIRNESS A4 — per-generation token accounting.
                inputTokensSent: evt.metrics?.inputTokens ?? null,
                inputTokensConsumed: evt.metrics?.inputTokens ?? null,
                contextWindow: evt.metrics?.contextWindow ?? null,
                outputTokens: evt.metrics?.outputTokens ?? null,
                timeToFirstTokenMs: firstTokenMs,
                updatedAt: new Date(),
              })
              .where(eq(reviews.id, review.id));
            sse("done", {
              review: evt.review,
              raw_output: evt.rawOutput,
              generation_ms: evt.generationMs,
            });
            if (judge) {
              const paperText = renderPaperText(
                paperStructure as unknown as Parameters<typeof renderPaperText>[0],
              );
              void scoreOneReview(review.id, evt.review, paperText, judge).catch(
                (err: unknown) =>
                  req.log?.warn?.({ err, reviewId: review.id }, "judge failed"),
              );
            }
          } else if (evt.kind === "error") {
            await db
              .update(reviews)
              .set({
                status: "FAILED",
                errorMessage: evt.message,
                rawOutput: accumulated || null,
                updatedAt: new Date(),
              })
              .where(eq(reviews.id, review.id));
            sse("error", { message: evt.message });
          }
        }
      } catch (err) {
        // If the abort came from the browser disconnecting, leave the
        // row in GENERATING — another opener can retry. Only flip to
        // FAILED for genuine upstream errors.
        if (abortController.signal.aborted) {
          req.log?.info?.({ reviewId }, "stream aborted by client disconnect");
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        await db
          .update(reviews)
          .set({ status: "FAILED", errorMessage: message, updatedAt: new Date() })
          .where(eq(reviews.id, review.id))
          .catch(() => {/* best effort */});
        try {
          sse("error", { message });
        } catch {/* socket already closed */}
        throw err;
      }
    })();

    inFlightStreams.set(reviewId, work);
    try {
      await work;
    } finally {
      inFlightStreams.delete(reviewId);
      req.off("close", onClose);
      try {
        res.end();
      } catch {/* already ended */}
    }
  });

  return router;
}
