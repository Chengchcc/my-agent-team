/** Unified token/cost statistics. Missing fields are allowed to be absent. */
export interface Usage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly costUsd?: number;
}

/** How one tool call should be shown to a human. The TOOL authors it — it is
 *  the only layer that knows what is safe and useful to show — and every
 *  surface (Lark card, Web) renders from it instead of from raw arguments.
 *  Raw input/output never cross the process boundary for display. */
export interface ToolPresentation {
  /** Short human label: "运行测试", "读取文件". */
  readonly title: string;
  /** One-line safe context: a command preview, a relative path. */
  readonly detail?: string;
  readonly icon?: "read" | "edit" | "search" | "command" | "web" | "agent" | "generic";
  /** What the call produced, summarized safely ("命中 6 处，涉及 3 个文件"). */
  readonly resultSummary?: string;
  /** What went wrong, summarized safely. */
  readonly errorSummary?: string;
  /** `hidden` means "the tool ran; show the name only" (MCP default). */
  readonly visibility: "compact" | "expandable" | "hidden";
}

/** Stable core events observed by Product Backend. Backends map their native
 *  events onto this small set. Business state machines must never derive a
 *  terminal state from events - `BackendRunOutcome` is the only terminal
 *  authority. UI lifecycle observation uses the open-ended `status` event. */
export type CoreBackendEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "thinking_delta"; readonly text: string }
  | { readonly type: "product_tool_started"; readonly toolName: string; readonly callId: string }
  | {
      readonly type: "product_tool_completed";
      readonly toolName: string;
      readonly callId: string;
      readonly result?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "native_tool_started";
      readonly toolName: string;
      readonly callId: string;
      /** Pre-sanitized, short, user-visible description of the activity
       *  ("正在执行：bun test apps/…"). Never raw tool args. Absent when the
       *  tool cannot describe itself (MCP tools, product tools) — surfaces
       *  then display the tool name alone. Kept for surfaces that predate
       *  `presentation`; new code reads `presentation` first. */
      readonly activity?: string;
      /** Structured display metadata, authored by the tool. */
      readonly presentation?: ToolPresentation;
    }
  | {
      readonly type: "native_tool_completed";
      readonly toolName: string;
      readonly callId: string;
      readonly result?: Readonly<Record<string, unknown>>;
      /** Result-side display metadata (resultSummary / errorSummary). */
      readonly presentation?: ToolPresentation;
    }
  | { readonly type: "pending_action"; readonly actionId: string }
  | { readonly type: "status"; readonly status: string; readonly error?: string }
  | {
      readonly type: "delegation_batch_started";
      readonly batchId: string;
      readonly label: string;
      readonly agentCount: number;
    }
  | {
      readonly type: "delegation_agent_started";
      readonly batchId: string;
      readonly agentId: string;
      readonly label: string;
    }
  | {
      readonly type: "delegation_agent_completed";
      readonly batchId: string;
      readonly agentId: string;
      readonly label: string;
      readonly ok: boolean;
      readonly error?: string;
      readonly usage?: unknown;
    }
  | {
      readonly type: "delegation_batch_completed";
      readonly batchId: string;
      readonly ok: boolean;
      readonly agentCount: number;
      readonly totalTokens: number;
    };

/** Opaque Backend-specific event. The kind segment must match the producing
 *  Backend's `backendKind`; the event segment is Backend-private. Usable for
 *  diagnostics or UI enhancement, never for product state. Parameterized by
 *  `K` so a Backend of kind `K` can only emit `backend.<K>.<event>`. */
export interface BackendExtensionEvent<K extends string> {
  readonly type: `backend.${K}.${string}`;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** The full event union a Backend of kind `K` may emit. `K` defaults to
 *  `string` for the opaque (un-parameterized) consumer. */
export type BackendEvent<K extends string = string> = CoreBackendEvent | BackendExtensionEvent<K>;
