export interface ToolExecuteResult {
  content: string;
  isError?: boolean;
  /** If "internal", the model's next output after this tool result will be
   *  labeled with this role instead of "assistant". Used by memory_save etc. */
  role?: "internal";
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  execute(input: unknown, signal?: AbortSignal): ToolExecuteResult | Promise<ToolExecuteResult>;
}
