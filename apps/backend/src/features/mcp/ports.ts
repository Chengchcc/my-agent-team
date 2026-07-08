import type { McpServerRow } from "./domain.js";

export interface CreateMcpServerRecord {
  serverId: string;
  agentId: string;
  name: string;
  transport: string;
  command: string | null;
  args: string;
  env: string;
  url: string | null;
  enabled: number;
  createdAt: number;
  updatedAt: number;
}

export interface UpdateMcpServerRecord {
  name?: string;
  command?: string | null;
  args?: string | null;
  env?: string | null;
  url?: string | null;
  enabled?: number;
  updatedAt: number;
}

export interface McpServerPort {
  create(input: CreateMcpServerRecord): McpServerRow;
  listByAgent(agentId: string): McpServerRow[];
  getById(serverId: string): McpServerRow | null;
  update(serverId: string, patch: UpdateMcpServerRecord): McpServerRow | null;
  delete(serverId: string): boolean;
}
