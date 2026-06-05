export function checkAuth(req: Request, token: string): boolean {
  const header = req.headers.get("x-auth-token") ?? "";
  if (header.length !== token.length) return false;
  // L2: constant-time comparison to prevent timing attacks
  return crypto.timingSafeEqual(new TextEncoder().encode(header), new TextEncoder().encode(token));
}
