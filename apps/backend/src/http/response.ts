/** Shared utilities for HTTP feature files. */

/** Shared JSON response helper — single source across all HTTP feature files. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Parse JSON body, returning 400 on syntax error. Empty body → {}. */
export async function parseJsonBody(
  req: Request,
): Promise<{ data: unknown } | { error: Response }> {
  const text = await req.text().catch(() => "");
  if (text.trim() === "") return { data: {} };
  try {
    return { data: JSON.parse(text) };
  } catch {
    return { error: json({ error: "Invalid JSON" }, 400) };
  }
}

/** Shared SSE response constructor.
 *
 *  Heartbeat: when a yielded item has `_heartbeat: true`, it's emitted as
 *  an SSE comment `: ping\n\n` which browsers use for keepalive but do not
 *  fire as a message event. No business `event: done` is emitted — terminal
 *  state is expressed by message revision `state=done/error`, not by SSE close. */
export function sseResponse<T>(
  iterable: AsyncIterable<T>,
  serialize: (item: T) => { id: string; event: string; data: unknown },
  signal?: AbortSignal,
): Response {
  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          for await (const item of iterable) {
            if (signal?.aborted) break;
            // Heartbeat sentinel → SSE comment (keepalive, not business event)
            if ((item as { _heartbeat?: boolean })._heartbeat) {
              controller.enqueue(new TextEncoder().encode(": ping\n\n"));
              continue;
            }
            const { id, event, data } = serialize(item);
            const line = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
            controller.enqueue(new TextEncoder().encode(line));
          }
          // No default event: done — connection lifetime is driven by heartbeat + abort
          controller.close();
        } catch (err) {
          if ((err as Error)?.name === "AbortError") {
            controller.close();
          } else {
            const errMsg = err instanceof Error ? err.message : String(err);
            controller.enqueue(
              new TextEncoder().encode(
                `event: error\ndata: ${JSON.stringify({ error: errMsg })}\n\n`,
              ),
            );
            controller.close();
          }
        }
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    },
  );
}
