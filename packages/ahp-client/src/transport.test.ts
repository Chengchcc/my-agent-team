import { afterAll, expect, test } from "bun:test";
import { createWebSocketTransport } from "./transport.js";

/** 一个真 WS 服务端：打开即问好，收到什么回什么。 */
const server = Bun.serve({
  port: 0,
  fetch(req, srv) {
    if (srv.upgrade(req)) return undefined;
    return new Response("no websocket here", { status: 400 });
  },
  websocket: {
    open(ws) {
      ws.send("hello");
    },
    message(ws, raw) {
      ws.send(`echo:${typeof raw === "string" ? raw : JSON.stringify(raw)}`);
    },
  },
});

afterAll(() => {
  server.stop(true);
});

test("frames arrive in order and outbound messages go out verbatim", async () => {
  const transport = createWebSocketTransport(`ws://127.0.0.1:${server.port}`);
  expect(await transport.recv()).toEqual({ kind: "text", text: "hello" });
  await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" } as never);
  const echoed = await transport.recv();
  expect(echoed?.kind).toBe("text");
  expect(echoed?.kind === "text" ? echoed.text : "").toBe(
    'echo:{"jsonrpc":"2.0","id":1,"method":"ping"}',
  );
  transport.close();
  expect(await transport.recv()).toBeNull();
});

test("a pre-serialized frame is passed through untouched", async () => {
  const transport = createWebSocketTransport(`ws://127.0.0.1:${server.port}`);
  await transport.recv();
  await transport.send('{"jsonrpc":"2.0","id":2,"method":"pong"}');
  const echoed = await transport.recv();
  expect(echoed?.kind === "text" ? echoed.text : "").toBe(
    'echo:{"jsonrpc":"2.0","id":2,"method":"pong"}',
  );
  transport.close();
});

test("an aborted signal tears the transport down instead of hanging", async () => {
  const controller = new AbortController();
  const transport = createWebSocketTransport(`ws://127.0.0.1:${server.port}`, {
    signal: controller.signal,
  });
  await transport.recv(); // "hello"
  controller.abort();
  await expect(transport.recv()).rejects.toThrow(/aborted/);
});
