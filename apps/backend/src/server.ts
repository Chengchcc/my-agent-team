import type { BackendConfig } from "./config.js";
import type { createRouter } from "./http/router.js";

export function createServer(config: BackendConfig, router: ReturnType<typeof createRouter>) {
  let server: ReturnType<typeof Bun.serve> | null = null;

  return {
    start() {
      server = Bun.serve({
        port: config.port,
        hostname: config.host,
        fetch: (req) => router(req),
      });
      console.log(`[backend] listening on http://${config.host}:${config.port}`);
    },

    stop() {
      server?.stop();
    },
  };
}
