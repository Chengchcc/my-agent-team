import type { Tool, ToolExecuteResult } from "@chengchenccc/message";

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolCaller {
  /** `_meta` is the MCP implementation-metadata bag: the caller-supplied
   *  identity rides it to the server (product tools read
   *  `_meta.identity.callId` as the idempotency identity). */
  callTool(params: {
    name: string;
    arguments?: unknown;
    _meta?: Record<string, unknown>;
  }): Promise<{ content: unknown }>;
}

/** lowercase + replace non-[a-z0-9] with `-`, trim leading/trailing `-`, fallback to "server". */
export function sanitizeServerName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "server";
}

/** returns `mcp__{sanitizedServerName}__{toolName}`. */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeServerName(serverName)}__${toolName}`;
}

/** Adapt an MCP tool definition into the `Tool` interface. */
export function adaptMcpTool(
  serverName: string,
  mcpTool: McpToolDefinition,
  caller: McpToolCaller,
): Tool {
  const name = mcpToolName(serverName, mcpTool.name);
  const description = mcpTool.description ?? `MCP tool: ${mcpTool.name}`;
  const inputSchema = mcpTool.inputSchema ?? { type: "object", properties: {} };

  return {
    name,
    description,
    inputSchema,
    // ponytail: signal not forwarded - MCP SDK callTool doesn't accept AbortSignal yet
    async execute(
      input: unknown,
      _signal?: AbortSignal,
      options?: { callId?: string },
    ): Promise<ToolExecuteResult> {
      try {
        // The loop's call id IS the model's tool_use id: a product tool that
        // writes (todo_write, ask_question) must be replayable under the same
        // identity after a crash instead of being re-minted server-side.
        const result = await caller.callTool({
          name: mcpTool.name,
          arguments: input,
          ...(options?.callId ? { _meta: { identity: { callId: options.callId } } } : {}),
        });
        return {
          content:
            typeof result.content === "string" ? result.content : JSON.stringify(result.content),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: message, isError: true };
      }
    },
  };
}
