/** Stable reference to a model within a specific Agent Backend kind. `K`
 *  constrains the ref to the Backend's own kind so a Backend of kind "fake"
 *  cannot receive a "claude-code" model ref. */
export interface BackendModelRef<K extends string = string> {
  readonly backendKind: K;
  readonly modelId: string;
  /** Thinking-mode effort (Anthropic-format `reasoning` param): none/low/
   *  high/max. Undefined = provider default. */
  readonly reasoningEffort?: ReasoningEffort;
  /** For the ACP kind: which model the *harness* should run, in that
   *  harness's own vocabulary (acp `configOptions` values - claude offers
   *  `opus`, omp offers `deepseek/deepseek-v4-pro`). The harness itself is
   *  the ref's identity (modelId); this is what it runs. Undefined = the
   *  harness's own default. */
  readonly harnessModel?: string;
  /** For the ACP kind: which harness runs this (a key of the ACP registry).
   *  Supersedes the older packing of that key into `modelId` as `acp/<key>`;
   *  readers prefer this field and fall back to that form. */
  readonly harness?: string;
}

/** The canonical reasoning-effort rungs. ONE list, shared by the product
 *  (agent.yml / HTTP / web) and every backend that consumes a model ref. */
export const REASONING_EFFORTS = ["none", "low", "high", "max"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Narrow an untrusted value (DB row, env, wire payload) to the canonical
 *  enum. Unknown/blank values drop to undefined = "provider default" rather
 *  than failing a whole Run at the wire schema. */
export function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value)
    ? (value as ReasoningEffort)
    : undefined;
}

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

/** A backend's model listing. ModelRef must match the catalog's backendKind. */
export interface BackendModelCatalog {
  readonly backendKind: string;
  readonly models: readonly BackendModel[];
}

/** Uniform per-kind catalog facade consumed by execution preflight and the
 *  /api/models aggregation. The registry key carries the kind; the catalog's
 *  own list() result keeps its backendKind for the wire. */
export interface BackendCatalog {
  list(): Promise<{ readonly models: readonly BackendModel[] }>;
}
