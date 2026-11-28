import type { AIMessageChunk, Message } from "@chengchenccc/message";
import type { Model, ProviderStreamOptions } from "./types.js";

/** Per-stream SSE frame converter. May attach an optional `flush()` hook
 *  called once when the SSE stream ends cleanly (used by protocols whose
 *  usage frame arrives after finish_reason). */
export type ChunkConverter = ((raw: Record<string, unknown>) => Generator<AIMessageChunk>) & {
  flush?: () => Generator<AIMessageChunk>;
};

/** ISP: minimal interface per API protocol — buildRequest + convertChunks.
 *  OCP: new protocol = new file + registerApi(), no existing file changes. */
export interface ApiImplementation {
  buildRequest(
    model: Model,
    messages: readonly Message[],
    opts?: ProviderStreamOptions,
  ): { url: string; headers: Record<string, string>; body: Record<string, unknown> };

  createChunkConverter(): ChunkConverter;
}

const registry = new Map<string, ApiImplementation>();

export function registerApi(api: string, impl: ApiImplementation): void {
  registry.set(api, impl);
}

export function getApiImplementation(api: string): ApiImplementation {
  const impl = registry.get(api);
  if (!impl) throw new Error(`No implementation registered for API: ${api}`);
  return impl;
}

export function hasApiImplementation(api: string): boolean {
  return registry.has(api);
}
