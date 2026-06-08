import type { NextRequest } from "next/server";
import { readSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const session = await readSession(req.headers.get("cookie"));
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const BACKEND_URL = process.env.BACKEND_URL!;
  const BACKEND_TOKEN = process.env.BACKEND_TOKEN!;

  const url = new URL(req.url);
  const afterSeq = url.searchParams.get("afterSeq") ?? "";
  const upstreamUrl = `${BACKEND_URL}/api/runs/${id}/events${afterSeq ? `?afterSeq=${afterSeq}` : ""}`;

  const upstream = await fetch(upstreamUrl, {
    headers: {
      "x-auth-token": BACKEND_TOKEN,
      "x-user-id": session.userId,
      "Last-Event-ID": req.headers.get("Last-Event-ID") ?? "",
    },
    signal: req.signal,
  });

  const responseHeaders = new Headers();
  responseHeaders.set("Content-Type", "text/event-stream");
  responseHeaders.set("Cache-Control", "no-cache, no-transform");
  responseHeaders.set("Connection", "keep-alive");
  responseHeaders.set("X-Accel-Buffering", "no");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
