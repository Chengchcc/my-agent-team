import { NextResponse } from "next/server";
import { logout } from "@/lib/auth";

export async function POST(): Promise<Response> {
  const resp = NextResponse.json({ ok: true });
  resp.headers.set("Set-Cookie", logout());
  return resp;
}
