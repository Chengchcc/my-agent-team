import { NextResponse } from "next/server";
import { logout } from "@/lib/auth";

export async function POST(req: Request): Promise<Response> {
  const accept = req.headers.get("accept") ?? "";
  const resp = accept.includes("application/json")
    ? NextResponse.json({ ok: true })
    : NextResponse.redirect(new URL("/login", req.url));
  resp.headers.set("Set-Cookie", logout());
  return resp;
}
