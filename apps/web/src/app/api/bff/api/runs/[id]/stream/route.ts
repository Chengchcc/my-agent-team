import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

// M13: delta stream — not implemented yet
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  void params;
  return new Response(JSON.stringify({ error: "Not implemented — M13" }), {
    status: 501,
    headers: { "Content-Type": "application/json" },
  });
}
