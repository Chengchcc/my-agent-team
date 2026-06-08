import { type NextRequest, NextResponse } from "next/server";
import { login } from "@/lib/auth";

export async function POST(req: NextRequest): Promise<Response> {
  const body = await req.json().catch(() => null);
  const password = body?.password ?? "";
  const result = await login(password);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 401 });
  }
  const resp = NextResponse.json({ ok: true });
  resp.headers.set("Set-Cookie", result.cookie);
  return resp;
}
