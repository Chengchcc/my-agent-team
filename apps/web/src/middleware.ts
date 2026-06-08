import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Paths accessible without session
const PUBLIC_PREFIXES = ["/login", "/api/auth"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow public paths
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Allow static assets and Next.js internals
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }

  // Check for session cookie (BFF will verify HMAC server-side;
  // middleware only checks existence for UX redirect)
  const session = req.cookies.get("maw_session");
  if (!session?.value) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  return NextResponse.next();
}
