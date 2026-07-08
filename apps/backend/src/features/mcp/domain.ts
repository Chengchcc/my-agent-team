export interface McpServerRow {
  serverId: string;
  agentId: string;
  name: string;
  transport: "stdio" | "sse";
  command: string | null;
  args: string[] | null;
  env: Record<string, string> | null;
  url: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateMcpServerInput {
  name: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
}

export interface UpdateMcpServerInput {
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
}
