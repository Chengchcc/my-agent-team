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
   *  ("正在执行：bun test apps/backend"). This string crosses the process
   *  boundary and reaches every surface (TUI, Web, Lark), so the tool that
   *  knows the input's meaning owns the redaction and truncation — never
   *  return raw args, absolute paths, tokens, or multi-line text. Return
   *  undefined (or an empty string) to fall back to the tool name. */
  describeStart?(input: unknown): string | undefined;
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
