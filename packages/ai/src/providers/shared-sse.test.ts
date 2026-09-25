import { describe, expect, test } from "bun:test";
import { DEFAULT_SSE_IDLE_TIMEOUT_MS, fetchSSE } from "./shared-sse.js";

/** Install a fetch double for one test. The real fetch errors its response
 *  body when the request signal aborts, so the double must too — a stream
 *  that ignores abort would only prove the test's own stub can hang. */
function withFetch(
  impl: (init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = (_url: string, init?: RequestInit) => impl(init);
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

/** A response whose body never produces a byte — the incident shape: the
 *  connection is accepted and then the provider says nothing. */
function silentBody(init?: RequestInit): Response {
  const signal = init?.signal;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => {
        controller.error(new Error("request aborted"));
      });
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunksBody(chunks: string[], gapMs: number): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        await new Promise((r) => setTimeout(r, gapMs));
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("fetchSSE idle timeout", () => {
  test("a silent provider fails fast instead of stalling the run", async () => {
    let message = "";
    const started = Date.now();
    await withFetch(
      (init) => Promise.resolve(silentBody(init)),
      async () => {
        try {
          for await (const _ of fetchSSE({
            url: "https://x",
            headers: {},
            body: "{}",
            idleTimeoutMs: 25,
          })) {
            void _;
          }
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
      },
    );
    expect(message).toContain("model stream idle");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("chunks reset the clock, so a slow-but-alive stream survives", async () => {
    const seen: unknown[] = [];
    await withFetch(
      () =>
        Promise.resolve(
          chunksBody(['data: {"a":1}\n\n', 'data: {"b":2}\n\n', "data: [DONE]\n\n"], 15),
        ),
      async () => {
        for await (const ev of fetchSSE({
          url: "https://x",
          headers: {},
          body: "{}",
          idleTimeoutMs: 60,
        })) {
          seen.push(ev);
        }
      },
    );
    expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("the default bound is two minutes", () => {
    expect(DEFAULT_SSE_IDLE_TIMEOUT_MS).toBe(120_000);
  });
});
