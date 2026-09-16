// Minimal Anthropic Messages API mock (SSE) for the end-to-end acceptance run.
//
// Why it exists: the artifact acceptance test must prove that a Run completes
// through a real model call path, without spending model quota and without a
// key. Point a provider at this server (`ANTHROPIC_BASE_URL=https://…` shape —
// the base URL must include /v1: the Anthropic adapter appends /messages).
//
//   bun scripts/mock-anthropic.ts            # listens on 127.0.0.1:8099
//   ANTHROPIC_AUTH_TOKEN=mock ANTHROPIC_BASE_URL=http://127.0.0.1:8099/v1 oma --up
//
// Every request is logged BEFORE the path check: a 404 from a wrong base URL
// is otherwise invisible.
const PORT = Number(process.env.MOCK_ANTHROPIC_PORT ?? 8099);
const REPLY = "mock-model reply: stack is alive";

function sse(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const body = await req.text();
    console.log(`[mock] ${req.method} ${url.pathname} (${body.length} bytes)`);
    if (!url.pathname.endsWith("/messages")) {
      return new Response("not found", { status: 404 });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (name: string, payload: unknown): void => {
          controller.enqueue(encoder.encode(sse(name, payload)));
        };
        send("message_start", {
          type: "message_start",
          message: {
            id: "msg_mock",
            type: "message",
            role: "assistant",
            model: "claude-haiku-4-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        });
        send("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
        send("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: REPLY },
        });
        send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 8 },
        });
        send("message_stop", { type: "message_stop" });
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  },
});
console.log(`anthropic mock listening on http://127.0.0.1:${PORT}`);
