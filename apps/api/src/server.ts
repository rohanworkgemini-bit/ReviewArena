import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
loadEnv({ path: resolve(fileURLToPath(import.meta.url), "../../../../.env") });

import express, { type Express } from "express";
import { sql } from "drizzle-orm";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { loadConfig, webOriginList } from "./config.js";
import { db } from "./db/client.js";
import { logger } from "./logger.js";
import { sessionMiddleware } from "./plugins/session.js";
import { papersRouter } from "./routes/papers.js";
import { reviewsStreamRouter } from "./routes/reviews-stream.js";
import { pairRouter } from "./routes/pair.js";
import { votesRouter } from "./routes/votes.js";
import { leaderboardRouter } from "./routes/leaderboard.js";
import { revealRouter } from "./routes/reveal.js";
import { adminRouter } from "./routes/admin.js";
import { ReviewGenClient } from "./clients/review-gen-client.js";
import { JudgeClient } from "./clients/judge-client.js";
import { makeOrchestrator } from "./pipeline/orchestrator.js";

const config = loadConfig();

// One set of clients per process. Routes that need them are handed
// references — avoids constructing two ReviewGenClient + JudgeClient
// pairs (one in papers.ts, one in admin.ts) that each held their own
// undici dispatcher and connection pool.
const reviewGen = new ReviewGenClient(config.REVIEW_GEN_URL, config.REVIEW_GEN_API_KEY);
const judge = new JudgeClient(config.REVIEW_GEN_URL, config.REVIEW_GEN_API_KEY);
const orchestrator = makeOrchestrator(reviewGen, judge);

const app: Express = express();

// Per-request log line — one short colored line per call, no cookie/header
// dump. 2xx → info, 4xx → warn, 5xx + errors → error. Polling endpoints
// (/health and per-paper status poll) are silenced on success so they
// don't drown real activity.
app.use(
  pinoHttp({
    logger,
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    customSuccessMessage: (req, res, responseTime) =>
      `${req.method} ${req.url} → ${res.statusCode} (${Math.round(responseTime)}ms)`,
    customErrorMessage: (req, res, err) =>
      `${req.method} ${req.url} → ${res.statusCode} ${err?.message ?? ""}`.trim(),
    serializers: {
      req: () => undefined,
      res: () => undefined,
    },
    autoLogging: {
      ignore: (req) => {
        const url = req.url ?? "";
        if (url === "/health") return true;
        // /papers/:id is polled every 1.5s during generation — silence
        // successful GETs but the path's failures still log (different
        // code path).
        if (req.method === "GET" && /^\/papers\/[a-z0-9]+$/.test(url)) return true;
        return false;
      },
    },
  }),
);
// CORS — whitelist WEB_ORIGIN(s) only. `origin: true` would reflect any
// origin with credentials=true, which is a textbook CSRF setup for the
// vote API. We compare exact strings (no wildcards); add multiple origins
// via comma-separated WEB_ORIGIN if you need preview deploys.
const allowedOrigins = webOriginList(config);
app.use(
  cors({
    origin: (origin, cb) => {
      // No Origin header: same-origin / curl / mobile webview — allow.
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  }),
);
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use(sessionMiddleware);

// /health — actual readiness probe. Pings the DB so a misconfigured
// connection string or unreachable Postgres reports 503 instead of
// silently lying. The DB ping is sub-millisecond on a warm pool.
app.get("/health", async (_req, res) => {
  try {
    await db.execute(sql`SELECT 1`);
    res.json({ ok: true, db: "ok" });
  } catch (err) {
    // SECURITY: /health is publicly reachable. A DB failure message
    // would leak the Neon hostname, role, or connection-string detail —
    // useful intel for an attacker. Log full error server-side; return
    // an opaque status to the client.
    logger.error({ err }, "healthz: db unreachable");
    res.status(503).json({ ok: false, db: "unreachable" });
  }
});

app.use(papersRouter(config, { reviewGen, judge, orchestrator }));
app.use(reviewsStreamRouter({ reviewGen, judge }));
app.use(pairRouter(config));
app.use(votesRouter(config));
app.use(leaderboardRouter());
app.use(revealRouter());
app.use(adminRouter(config, { reviewGen, judge, orchestrator }));

// Final error handler — converts thrown errors into JSON envelopes so the
// frontend's jsonOrThrow() can show something useful.
//
// SECURITY: never include err.message in the response — it can leak SQL
// fragments, stack frames, filesystem paths, or third-party API error
// detail. Full error stays in server logs (with request_id-equivalent
// via pino's auto-generated reqId) for debugging.
app.use(
  (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, "unhandled");
    res.status(500).json({
      error: "InternalError",
      message: "An unexpected error occurred. Check server logs for details.",
    });
  },
);

const server = app.listen(config.API_PORT, "0.0.0.0", () => {
  console.log(`[ReviewArena api] listening on :${config.API_PORT}`);
});

// Graceful shutdown: on SIGTERM/SIGINT, stop accepting new connections,
// let in-flight requests (including SSE streams) finish for up to 30s,
// then exit. Without this, `kill <pid>` (or container orchestrator
// signals) yanks the socket out from under live SSE streams and the
// reviews row stays GENERATING forever.
const SHUTDOWN_TIMEOUT_MS = 30_000;
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutdown: closing server");
  server.close((err) => {
    if (err) logger.error({ err }, "shutdown: server.close failed");
    process.exit(err ? 1 : 0);
  });
  setTimeout(() => {
    logger.warn({ signal }, "shutdown: timed out, exiting hard");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { app };
