import pino from "pino";

// Process-wide logger. Request handlers use the per-request `req.log` from
// pino-http; background work (pipeline, scoring) has no request context and
// logs through this instead so failures aren't swallowed silently.
//
// NB: this module is evaluated at import time, which (because ES imports are
// hoisted) happens before server.ts runs dotenv. So it must NOT call
// loadConfig() — the full env isn't populated yet. Reading NODE_ENV directly
// with a fallback is safe; the level is the only thing the logger needs.
const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: isDev ? "debug" : "info",
  // In dev, pipe through pino-pretty so the terminal sees colored,
  // single-line output instead of a 1 KB JSON blob per request. In prod
  // we leave it as JSON so the log shipper / cloud aggregator can parse
  // structured fields.
  transport: isDev
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss",
          ignore: "pid,hostname,req,res,responseTime,reqId",
          singleLine: true,
          messageFormat: "{msg}",
        },
      }
    : undefined,
});
