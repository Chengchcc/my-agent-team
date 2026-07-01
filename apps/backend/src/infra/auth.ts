export function checkAuth(req: Request, token: string): boolean {
  return checkAuthToken(req.headers.get("x-auth-token") ?? "", token);
}

/** Header-string version — for Elysia macro (no Request object available). */
export function checkAuthToken(header: string, token: string): boolean {
  if (header.length !== token.length) return false;
  // L2: constant-time comparison to prevent timing attacks
  return crypto.timingSafeEqual(new TextEncoder().encode(header), new TextEncoder().encode(token));
}
