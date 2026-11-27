import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time equality over arbitrary UTF-8 strings. Hashing both inputs to
 *  fixed 32-byte SHA-256 digests avoids UTF-16 vs UTF-8 byte-length mismatches
 *  (which throw RangeError in timingSafeEqual) and closes length side channels. */
export function safeTokenEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export function checkAuth(req: Request, token: string): boolean {
  return checkAuthToken(req.headers.get("x-auth-token") ?? "", token);
}

/** Header-string version — for Elysia macro (no Request object available). */
export function checkAuthToken(header: string, token: string): boolean {
  if (header.length === 0 || token.length === 0) return false;
  return safeTokenEqual(header, token);
}
