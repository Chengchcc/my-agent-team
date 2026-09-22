import type { BackendConfig } from "./config.js";

/** Elysia's generic WebSocket dispatcher (the contract of
 *  elysia/dist/ws/index.mjs): Bun-level hooks delegate to the per-route
 *  handlers Elysia carries on `ws.data`. */
interface ElysiaWsData {
  open?: (ws: Bun.ServerWebSocket<ElysiaWsData>) => void | Promise<void>;
  message?: (ws: Bun.ServerWebSocket<ElysiaWsData>, message: unknown) => void | Promise<void>;
  close?: (
    ws: Bun.ServerWebSocket<ElysiaWsData>,
    code: number,
    reason: string,
  ) => void | Promise<void>;
}

const wsDispatch = {
  open: (ws: Bun.ServerWebSocket<ElysiaWsData>) => ws.data.open?.(ws),
  message: (ws: Bun.ServerWebSocket<ElysiaWsData>, message: unknown) =>
    ws.data.message?.(ws, message),
  close: (ws: Bun.ServerWebSocket<ElysiaWsData>, code: number, reason: string) =>
    ws.data.close?.(ws, code, reason),
};

/** Structural app surface createServer actually needs — createApp's
 *  return satisfies it; tests pass a minimal Elysia without dragging the
 *  full decorated-app type along. */
export interface ServeableApp {
  fetch: (request: Request) => Response | Promise<Response>;
}

export function createServer(config: BackendConfig, app: ServeableApp) {
  let server: ReturnType<typeof Bun.serve> | null = null;

  return {
    start() {
      server = Bun.serve({
        port: config.port,
        hostname: config.host,
        idleTimeout: 0, // disable — SSE connections are long-lived
        fetch: app.fetch,
        // WebSocket routes (coding terminals) need BOTH pieces that
        // app.listen() would provide: the Bun-level dispatcher, and
        // `app.server` — Elysia's ws handler calls server.upgrade() from
        // inside fetch, which 404s without it (runtime-proven 2026-09-22:
        // e2e via app.listen() hid this; the real serving path rejected
        // every WS upgrade).
        websocket: wsDispatch as Bun.WebSocketHandler<ElysiaWsData>,
      });
      // Elysia types `server` as a brand ('Elysia' | string), but at
      // runtime it is the Bun.Server instance — named cast, set once here.
      const holder = app as unknown as { server: ReturnType<typeof Bun.serve> | null };
      holder.server = server;
      console.log(`[backend] listening on http://${config.host}:${config.port}`);
    },

    /** Actual listening port (config.port may be 0 for ephemeral). */
    port(): number {
      return server?.port ?? 0;
    },

    stop() {
      server?.stop();
    },
  };
}
