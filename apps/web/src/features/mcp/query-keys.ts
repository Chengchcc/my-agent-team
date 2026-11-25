export const mcpKeys = {
  /** The catalog's own key and the prefix of every other MCP read. */
  all: ["mcp-catalog"] as const,
  server: (serverId: string) => [...mcpKeys.all, "server", serverId] as const,
  tools: (serverId: string) => [...mcpKeys.all, "tools", serverId] as const,
};
