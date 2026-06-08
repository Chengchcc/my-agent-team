import type { NextRequest } from "next/server";
import { proxyRequest } from "@/lib/bff";
import { readSession } from "@/lib/session";

async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await params;
  const session = await readSession(req.headers.get("cookie"));
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return proxyRequest(req, path, session.userId);
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
