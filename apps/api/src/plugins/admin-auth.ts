import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

// Admin endpoints use a single bearer token from ADMIN_TOKEN. No user model.

export function requireAdmin(adminToken: string) {
  const adminBuf = Buffer.from(adminToken, "utf8");
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!presented || !constantTimeEqual(presented, adminBuf)) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Valid admin bearer token required.",
      });
      return;
    }
    next();
  };
}

/** Constant-time string compare against a pre-allocated reference buffer.
 *  Length mismatch returns false but only after a full compare against a
 *  padded copy, so the timing signal can't differentiate "right length /
 *  wrong bytes" from "wrong length". */
function constantTimeEqual(input: string, reference: Buffer): boolean {
  const inputBuf = Buffer.from(input, "utf8");
  // Always compare against a buffer of the reference length so the
  // expensive op runs in O(reference.length) regardless of input.
  const padded = Buffer.alloc(reference.length);
  inputBuf.copy(padded, 0, 0, Math.min(inputBuf.length, reference.length));
  const ok = nodeTimingSafeEqual(padded, reference);
  return ok && inputBuf.length === reference.length;
}
