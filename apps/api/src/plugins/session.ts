import type { Request, Response, NextFunction } from "express";
import { randomBytes } from "node:crypto";

// Anonymous session id, set as an httpOnly cookie on first request.
// Used solely to dedupe / rate-limit votes. No PII is collected.
//
// cookie-parser (registered globally in server.ts) populates req.cookies.
const COOKIE_NAME = "ra_sid";
const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      sessionId: string;
    }
  }
}

export function sessionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const existing = (req.cookies as Record<string, string>)[COOKIE_NAME];
  if (existing && existing.length >= 16) {
    req.sessionId = existing;
    return next();
  }
  const sid = randomBytes(24).toString("base64url");
  req.sessionId = sid;
  res.cookie(COOKIE_NAME, sid, {
    httpOnly: true,
    // `secure` requires HTTPS at the transport. Production always serves
    // over TLS; in dev we use http://localhost so secure would silently
    // drop the cookie. Gate on NODE_ENV.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: ONE_YEAR_MS,
    path: "/",
  });
  next();
}
