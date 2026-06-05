export interface ToolExecuteResult {
  content: string;
  isError?: boolean;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  execute(input: unknown, signal?: AbortSignal): ToolExecuteResult | Promise<ToolExecuteResult>;
}
