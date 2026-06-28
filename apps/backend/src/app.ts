import { Elysia } from "elysia";

/**
 * Create the Elysia application with all feature routes.
 *
 * This is the single source of truth for the HTTP API contract.
 * `export type App = ReturnType<typeof createApp>` is consumed by:
 *   - web: treaty<App>("/api/bff", ...)
 *   - lark-bot: treaty<App>(backendUrl, ...)
 *
 * Phase 1 (PR-1): health route only — skeleton coexists with legacy Bun.serve router.
 * Phase 2 (PR-2): all feature routes migrated here, legacy router deleted.
 */
export function createApp(_token: string, _features?: unknown) {
  return new Elysia().get("/health", () => ({ status: "ok" }));
}

export type App = ReturnType<typeof createApp>;
