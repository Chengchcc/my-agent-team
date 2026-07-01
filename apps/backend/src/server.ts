import type { createApp } from "./app.js";
import type { BackendConfig } from "./config.js";

export function createServer(config: BackendConfig, app: ReturnType<typeof createApp>) {
  let server: ReturnType<typeof Bun.serve> | null = null;

  return {
    start() {
      server = Bun.serve({
        port: config.port,
        hostname: config.host,
        idleTimeout: 0, // disable — SSE connections are long-lived
        fetch: app.fetch,
      });
      console.log(`[backend] listening on http://${config.host}:${config.port}`);
    },

    stop() {
      server?.stop();
    },
  };
}
