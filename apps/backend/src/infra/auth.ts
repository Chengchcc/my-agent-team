export function checkAuth(req: Request, token: string): boolean {
  return req.headers.get("x-auth-token") === token;
}
