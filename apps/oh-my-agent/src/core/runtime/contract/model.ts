/** Backend-exposed model metadata. Aggregated by Product Backend across backends. */
export interface BackendModel {
  readonly id: string;
  readonly displayName: string;
  readonly reasoning: boolean;
  readonly inputModalities: readonly string[];
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly available: boolean;
  readonly cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** A backend's model listing. The oma catalog answers with its own kind. */
export interface BackendModelCatalog {
  readonly backendKind: string;
  readonly models: readonly BackendModel[];
}

// Reasoning-effort rungs and the untrusted-value narrow live in message
// (shared with the product surfaces); re-exported for one import site.
export { normalizeReasoningEffort, REASONING_EFFORTS, type ReasoningEffort } from "@chengchenccc/message";
