import { describe, expect, mock, test } from "bun:test";
import type { NextRequest } from "next/server";

// The route's only dependency worth pinning here is the session gate.
// proxyRequest itself is covered by src/lib/bff.test.ts — this file asserts
// the 401 wall and that a valid session reaches the proxy with its userId.
const readSession = mock(async (cookie: string | null) => {
  if (cookie === "session=valid") return { userId: "u9" };
  return null;
});

mock.module("@/lib/session", () => ({ readSession }));

process.env.BACKEND_AUTH_TOKEN = "be-secret";
process.env.BACKEND_URL = "http://backend.test:3000";

const realFetch = globalThis.fetch;
const { GET } = await import("./route");

// The handler only reads url/method/headers, which plain Request provides;
// NextRequest's extra surface is Next-internal.
function asNextRequest(req: Request): NextRequest {
  return req as unknown as NextRequest;
}

function bffRequest(cookie?: string) {
  return new Request("http://web.local/api/bff/api/agents", {
    headers: cookie ? { cookie } : {},
  });
}

describe("BFF catch-all route", () => {
  test("no session → 401 JSON without touching the backend", async () => {
    let upstreamCalled = 0;
    globalThis.fetch = (async () => {
      upstreamCalled++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await GET(asNextRequest(bffRequest()), {
      params: Promise.resolve({ path: ["api", "agents"] }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(upstreamCalled).toBe(0);
    globalThis.fetch = realFetch;
  });

  test("valid session proxies with the session userId attached", async () => {
    let seen: { url: string; userId: string | null } | null = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen = {
        url: String(input),
        userId: new Headers(init?.headers).get("x-user-id"),
      };
      return new Response('{"agents":[]}', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await GET(asNextRequest(bffRequest("session=valid")), {
      params: Promise.resolve({ path: ["api", "agents"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agents: [] });
    expect(seen!.url).toBe("http://backend.test:3000/api/agents");
    expect(seen!.userId).toBe("u9");
    globalThis.fetch = realFetch;
  });
});
