/** How one tool call should be shown to a human. Mirrors the agent-contract
 *  shape; declared here so the protocol package owns its own wire types (the
 *  two are kept aligned by `tools-presentation-drift.test.ts`). */
export interface ToolPresentation {
  readonly title: string;
  readonly detail?: string;
  readonly icon?: "read" | "edit" | "search" | "command" | "web" | "agent" | "generic";
  readonly resultSummary?: string;
  readonly errorSummary?: string;
  readonly visibility: "compact" | "expandable" | "hidden";
}

export interface ToolExecuteResult {
  content: string;
  isError?: boolean;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Declare whether a tool can safely run concurrently with other tools.
   *  "serial" (default) = must run alone, preserving existing behaviour.
   *  "concurrent" = read-only, no side effects, safe to run in parallel
   *  with other concurrent tools in the same turn. */
  readonly executionMode?: "serial" | "concurrent";
  /** What this call is DOING, in one short user-visible line
   *  ("正在执行：bun test apps/backend"). This crosses the process boundary and
   *  reaches every surface (TUI, Web, Lark), so the tool that knows the
   *  input's meaning owns the redaction and truncation — never return raw
   *  args, absolute paths, tokens, or multi-line text. Return undefined (or
   *  an empty string) to fall back to the tool name.
   *
   *  A plain string is the shorthand (title only); the structured form adds
   *  detail/icon/visibility so a surface can lay the call out properly. */
  describeStart?(input: unknown): ToolPresentation | string | undefined;
  /** What the call PRODUCED, summarized safely ("命中 6 处，涉及 3 个文件").
   *  Same redaction rules as describeStart; the raw result never travels. */
  describeResult?(input: unknown, result: unknown): ToolPresentation | string | undefined;
  execute(
    input: unknown,
    signal?: AbortSignal,
    /** Per-call execution context from the loop: the model tool-use id when
     *  the call originated from the model (stable idempotency identity). */
    options?: {
      callId?: string;
      /** Streaming partial output (e.g. bash stdout) for live display. */
      onOutput?: (partial: string) => void;
    },
  ): ToolExecuteResult | Promise<ToolExecuteResult>;
}
