/** DIP: StreamTransport. Only HTTP + SSE line splitting. Never inspects
 *  event content — that's ApiImplementation's job. */

export interface SSEFetchOpts {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  /** Abort when NO data arrives for this long (ms), counted from the request
   *  and reset by every chunk. A model that accepts the connection and then
   *  never answers used to stall its whole Run until the 30-minute wall-clock
   *  watchdog; the idle bound turns that into a fast, honest failure
   *  (observed 2026-09-25: an established, silent connection to the provider
   *  held a run for minutes). 0 disables. */
  idleTimeoutMs?: number;
}

export const DEFAULT_SSE_IDLE_TIMEOUT_MS = 120_000;

export async function* fetchSSE(opts: SSEFetchOpts): AsyncIterable<Record<string, unknown>> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_SSE_IDLE_TIMEOUT_MS;
  // One controller drives both the caller's cancellation and the idle bound.
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) onCallerAbort();
    else opts.signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleExpired = false;
  const armIdle = (): void => {
    if (idleTimeoutMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleExpired = true;
      controller.abort(new Error(`model stream idle for ${idleTimeoutMs}ms`));
    }, idleTimeoutMs);
  };
  armIdle();

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const res = await fetch(opts.url, {
      method: "POST",
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      const err = new Error(`status=${res.status} ${errBody}`);
      // Parse retry delay: prefer Anthropic's retry-after-ms (milliseconds),
      // fall back to standard Retry-After (seconds or HTTP-date). Both OpenAI
      // and most gateways use the standard header.
      const retryAfterMs = res.headers.get("retry-after-ms");
      const retryAfter = res.headers.get("retry-after");
      let delay: number | undefined;
      if (retryAfterMs) {
        const ms = Number.parseFloat(retryAfterMs);
        if (Number.isFinite(ms) && ms >= 0) delay = ms;
      }
      if (delay === undefined && retryAfter) {
        const secs = Number.parseFloat(retryAfter);
        if (Number.isFinite(secs) && secs >= 0) delay = secs * 1000;
        else {
          const date = Date.parse(retryAfter);
          if (!Number.isNaN(date)) delay = Math.max(0, date - Date.now());
        }
      }
      if (delay !== undefined) (err as Error & { retryAfterMs?: number }).retryAfterMs = delay;
      throw err;
    }
    if (!res.body) throw new Error("No response body");

    reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle(); // any byte counts as progress, including keep-alive comments
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        // Accept "data:" with zero or one trailing space (SSE allows both).
        const m = t.match(/^data: ?(.*)$/);
        if (!m) continue;
        const data = m[1] ?? "";
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data);
        } catch {
          /* skip malformed */
        }
      }
    }
  } catch (err) {
    if (idleExpired) {
      throw new Error(`model stream idle for ${idleTimeoutMs}ms (no data from the provider)`, {
        cause: err,
      });
    }
    throw err;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    opts.signal?.removeEventListener("abort", onCallerAbort);
    // Release the HTTP connection on normal end, [DONE] early-return, or throw.
    if (reader) await reader.cancel().catch(() => {});
  }
}
