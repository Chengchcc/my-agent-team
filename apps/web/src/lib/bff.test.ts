import { afterAll, describe, expect, test } from "bun:test";

// proxyRequest reads env lazily on first call and caches it — set the
// required vars before anything touches the module's env().
process.env.BACKEND_AUTH_TOKEN = "be-secret";
process.env.BACKEND_URL = "http://backend.test:3000";

const { passthroughHeaders, proxyRequest, stripHopByHop } = await import("./bff");

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

type FetchStub = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function asFetch(fn: FetchStub): typeof fetch {
  // Test double for the global; the union of our call shapes is narrower
  // than lib.dom's fetch overload set.
  return fn as unknown as typeof fetch;
}

/** Capture the upstream call; answer with a canned Response. */
function stubFetch(res: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = asFetch(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return res;
  });
  return calls;
}

function stubFetchError(err: Error) {
  globalThis.fetch = asFetch(async () => {
    throw err;
  });
}

describe("stripHopByHop", () => {
  test("removes hop-by-hop headers", () => {
    const h = new Headers({
      "content-type": "application/json",
      "transfer-encoding": "chunked",
      connection: "keep-alive",
    });
    const out = stripHopByHop(h);
    expect(out.get("content-type")).toBe("application/json");
    expect(out.get("transfer-encoding")).toBeNull();
    expect(out.get("connection")).toBeNull();
  });

  test("removes all standard hop-by-hop headers", () => {
    const h = new Headers({
      "keep-alive": "timeout=5",
      "proxy-authenticate": "Basic",
      "proxy-authorization": "Bearer x",
      te: "trailers",
      trailers: "x-custom",
      "transfer-encoding": "gzip",
      upgrade: "websocket",
    });
    const out = stripHopByHop(h);
    for (const [k] of h) {
      expect(out.get(k)).toBeNull();
    }
  });
});

describe("passthroughHeaders", () => {
  test("passes through allowed response headers", () => {
    const h = new Headers({
      "content-type": "application/json",
      "content-length": "100",
      "content-encoding": "gzip",
      "cache-control": "no-cache",
    });
    const out = passthroughHeaders(h);
    expect(out.get("content-type")).toBe("application/json");
    expect(out.get("cache-control")).toBe("no-cache");
    // undici transparently decodes the body; originals would mismatch.
    expect(out.get("content-length")).toBeNull();
    expect(out.get("content-encoding")).toBeNull();
  });

  test("filters out non-allowlisted response headers", () => {
    const h = new Headers({
      "content-type": "text/html",
      "x-custom": "secret",
      "set-cookie": "session=abc",
      "x-powered-by": "Express",
    });
    const out = passthroughHeaders(h);
    expect(out.get("content-type")).toBe("text/html");
    expect(out.get("x-custom")).toBeNull();
    expect(out.get("set-cookie")).toBeNull();
  });
});

describe("proxyRequest", () => {
  test("normalizes the leading api/ segment and forwards query + auth headers", async () => {
    const calls = stubFetch(new Response("{}", { status: 200 }));
    const req = new Request("http://web.local/api/bff/api/agents?page=2", {
      headers: { cookie: "session=abc" },
    });
    const res = await proxyRequest(req, ["api", "agents"], "u1");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://backend.test:3000/api/agents?page=2");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("x-auth-token")).toBe("be-secret");
    expect(headers.get("x-user-id")).toBe("u1");
    expect(headers.get("host")).toBeNull();
    expect(headers.get("cookie")).toBe("session=abc");
    expect(res.status).toBe(200);
  });

  test("paths without the api/ prefix are forwarded as-is", async () => {
    const calls = stubFetch(new Response("{}", { status: 200 }));
    await proxyRequest(new Request("http://web.local/api/bff/health"), ["health"], "u1");
    expect(calls[0]!.url).toBe("http://backend.test:3000/api/health");
  });

  test("GET sends no body; POST forwards the request bytes", async () => {
    const getCalls = stubFetch(new Response("{}", { status: 200 }));
    await proxyRequest(new Request("http://web.local/api/bff/api/agents"), ["agents"], "u1");
    expect(getCalls[0]!.init.body).toBeUndefined();

    const postCalls = stubFetch(new Response("{}", { status: 201 }));
    await proxyRequest(
      new Request("http://web.local/api/bff/api/agents", {
        method: "POST",
        body: JSON.stringify({ name: "a" }),
        headers: { "content-type": "application/json" },
      }),
      ["agents"],
      "u1",
    );
    const body = postCalls[0]!.init.body as ArrayBuffer;
    expect(new TextDecoder().decode(body)).toBe(JSON.stringify({ name: "a" }));
  });

  test("SSE paths detach the request signal; plain calls keep it", async () => {
    const sseCalls = stubFetch(new Response("data: x\n\n", { status: 200 }));
    const sseReq = new Request("http://web.local/api/bff/api/conversations/c1/stream");
    await proxyRequest(sseReq, ["conversations", "c1", "stream"], "u1");
    expect(sseCalls[0]!.init.signal).toBeUndefined();

    const plainCalls = stubFetch(new Response("{}", { status: 200 }));
    const plainReq = new Request("http://web.local/api/bff/api/agents");
    await proxyRequest(plainReq, ["agents"], "u1");
    expect(plainCalls[0]!.init.signal).toBe(plainReq.signal);
  });

  test("abort-like errors on SSE paths collapse to 204, others rethrow", async () => {
    stubFetchError(new Error("The operation was aborted"));
    const sse = await proxyRequest(
      new Request("http://web.local/api/bff/api/agent-runs/r1/events"),
      ["agent-runs", "r1", "events"],
      "u1",
    );
    expect(sse.status).toBe(204);

    stubFetchError(new Error("backend down"));
    expect(
      proxyRequest(new Request("http://web.local/api/bff/api/agents"), ["agents"], "u1"),
    ).rejects.toThrow("backend down");
  });

  test("upstream response: status + allowlisted headers + no-transform markers", async () => {
    stubFetch(
      new Response("payload", {
        status: 404,
        headers: {
          "content-type": "application/json",
          "x-custom": "drop me",
          "content-length": "7",
        },
      }),
    );
    const res = await proxyRequest(
      new Request("http://web.local/api/bff/api/agents"),
      ["agents"],
      "u1",
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("payload");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-custom")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-transform");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
  });
});
