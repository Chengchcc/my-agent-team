import type { Tool } from "@chengchenccc/message";

export type McpTransport = "stdio" | "sse";

export type McpConnectionStatus = "pending" | "connected" | "failed";

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
  /** Per-request timeout for tool calls on this server (ms). The MCP SDK
   *  defaults to 60s, which silently kills long-parking tools — the HITL
   *  ask parks for as long as a human needs (roadmap: 自由文本追问/HITL).
   *  Absent = the SDK default. */
  timeoutMs?: number;
}

/** Cached connection + discovered tools for one MCP server. */
export interface McpToolCatalogEntry {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpConnectionEntry {
  config: McpServerConfig;
  tools: Tool[];
  /** Raw server-side tool specs (unprefixed names) captured at connect. */
  rawToolSpecs: McpToolCatalogEntry[];
  client: unknown;
  transport: unknown;
  status: McpConnectionStatus;
  /** connect()+listTools() wall time in ms; undefined until a successful connect. */
  connectLatencyMs?: number;
}
