import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

/** A redirect hop must RESOLVE the hostname, not just read it: the first hop is
 *  already deep-guarded, so `302 -> http://internal.corp/admin` (no literal IP
 *  to pattern-match, private A record) was the way around the guard while the
 *  redirect site used the synchronous one. DNS is stubbed so containment is
 *  provable offline; the mock also has to be installed BEFORE the module graph
 *  under test is imported, hence the dynamic import below. */
mock.module("node:dns/promises", () => ({
  lookup: async (host: string) =>
    host === "internal.corp"
      ? [{ address: "10.1.2.3", family: 4 }]
      : [{ address: "93.184.216.34", family: 4 }],
}));

const { createStdWebFetchPort } = await import("./web-ports-std.js");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  mock.restore();
});

describe("web_fetch redirect hops resolve DNS", () => {
  test("a redirect to a hostname that resolves private is refused", async () => {
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://internal.corp/admin" },
      })) as unknown as typeof fetch;
    // Awaited: an unawaited `.rejects` assertion can pass before the rejection
    // is observed.
    await expect(createStdWebFetchPort().fetch("https://example.com/start")).rejects.toThrow(
      /resolves to private/,
    );
  });

  test("a redirect to a public hostname still follows", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/start")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://public.test/final" },
        });
      }
      return new Response("<title>F</title>final", { status: 200 });
    }) as unknown as typeof fetch;
    const out = await createStdWebFetchPort().fetch("https://example.com/start");
    expect(out.title).toBe("F");
    expect(calls).toHaveLength(2);
  });
});
