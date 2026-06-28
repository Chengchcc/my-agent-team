import type { z } from "zod";

/**
 * SSE event-name → zod-schema map.
 *
 * Single source of truth for both:
 *  - backend sseEncoder (parse → serialize → sseResponse)
 *  - frontend typedSource (EventSource addEventListener → JSON.parse → safeParse)
 *
 * Every key is an SSE `event:` string; every value is the zod schema for its `data:` payload.
 * Adding a new event without a corresponding schema entry is a compile error.
 */
export type SSEEventMap = Record<string, z.ZodType<unknown>>;

/**
 * SSE endpoint descriptor — binds a path template to its event map.
 * Both the URL builder (openSSE) and the typed consumer (typedSource) read from the same entry.
 */
export interface SSEEndpoint<M extends SSEEventMap> {
  /** Path template function — returns the relative path (without /api/bff prefix). */
  path: (...args: unknown[]) => string;
  /** Event map for this endpoint — event names → zod schemas. */
  events: M;
}

/**
 * Registry of all SSE endpoints.
 *
 * Frontend: `openSSE("conversationEvents", { id })` → typedSource with the correct map.
 * Backend: matches against registered paths for Elysia route mounting.
 */
export type SSEEndpoints = Record<string, SSEEndpoint<SSEEventMap>>;
