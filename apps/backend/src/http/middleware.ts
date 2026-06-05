import { checkAuth } from "../infra/auth.js";

export function withAuth(handler: (req: Request) => Promise<Response>, token: string) {
  return async (req: Request): Promise<Response> => {
    if (!checkAuth(req, token)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return handler(req);
  };
}
