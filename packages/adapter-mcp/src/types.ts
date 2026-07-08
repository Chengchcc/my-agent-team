import type { Tool } from "@my-agent-team/core";

export type McpTransport = "stdio" | "sse";

export interface McpServerConfig {
  serverId: string;
  agentId: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled: boolean;
}

/** Cached connection + discovered tools for one MCP server. */
export interface McpConnectionEntry {
  config: McpServerConfig;
  tools: Tool[];
  client: unknown;
  transport: unknown;
}
