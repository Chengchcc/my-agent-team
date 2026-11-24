import { afterEach, describe, expect, test } from "bun:test";
import { api } from "./api";

/** The wrapper accepted `parentRunId` and never sent it, so a page asking for
 *  one run's children received the console's newest runs (audit 2026-11-24). */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function capture(): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response(JSON.stringify({ runs: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { urls };
}

describe("api.listAgentRuns query", () => {
  test("forwards parentRunId", async () => {
    const { urls } = capture();
    await api.listAgentRuns({ parentRunId: "run-123", limit: 5 });
    expect(urls[0]).toContain("parentRunId=run-123");
  });

  test("forwards the abort signal", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Response(JSON.stringify({ runs: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await api.listAgentRuns({ parentRunId: "r", signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });
});
