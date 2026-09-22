import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import type { BackendConfig } from "./config.js";
import { createServer } from "./server.js";

// Regression (2026-09-22): createServer used to pass only `fetch` to
// Bun.serve and never set app.server — every WebSocket upgrade was a plain
// 404 on the REAL serving path, while e2e tests via app.listen() stayed
// green. This test goes through createServer itself.
describe("createServer websocket wiring", () => {
  test("Elysia ws routes upgrade and echo through the production path", async () => {
    const app = new Elysia()
      .get("/health", () => ({ ok: true }))
      .ws("/ws/p", {
        open(ws) {
          ws.send("hello");
        },
        message(ws) {
          ws.send("echo");
        },
      });
    const config = { port: 0, host: "127.0.0.1" } as unknown as BackendConfig;
    const server = createServer(config, app);
    server.start();
    const port = server.port();

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/p`);
      const got: string[] = [];
      ws.addEventListener("message", (ev) => got.push(String(ev.data)));
      await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
      ws.send("ping");
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      expect(got).toContain("hello");
      expect(got).toContain("echo");
      ws.close();
    } finally {
      server.stop();
    }
  }, 10_000);
});
