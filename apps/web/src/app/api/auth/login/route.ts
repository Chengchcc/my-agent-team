import { type NextRequest, NextResponse } from "next/server";
import { login } from "@/lib/auth";

export async function POST(req: NextRequest): Promise<Response> {
  // Accept both JSON (fetch) and form-urlencoded (native form)
  const contentType = req.headers.get("content-type") ?? "";
  const password = contentType.includes("application/json")
    ? ((await req.json().catch(() => ({}))) as { password?: string })?.password ?? ""
    : (await req.formData().catch(() => new FormData())).get("password")?.toString() ?? "";

  const result = await login(password);
  if ("error" in result) {
    // For JSON requests, return 401 JSON. For form, redirect back to login.
    if (contentType.includes("application/json")) {
      return NextResponse.json({ error: result.error }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login?error=1", req.url));
  }

  // 302 redirect — browser processes Set-Cookie natively on navigation
  const resp = NextResponse.redirect(new URL("/agents", req.url));
  resp.headers.set("Set-Cookie", result.cookie);
  return resp;
}
