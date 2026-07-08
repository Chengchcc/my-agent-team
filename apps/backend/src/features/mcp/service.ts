import type { McpClientManager } from "@my-agent-team/adapter-mcp";
import { ulid } from "../../infra/ids.js";
import type { CreateMcpServerInput, McpServerRow, UpdateMcpServerInput } from "./domain.js";
import type { McpServerPort } from "./ports.js";

export class McpServerNotFoundError extends Error {
  constructor(id: string) {
    super(`MCP server not found: ${id}`);
    this.name = "McpServerNotFoundError";
  }
}

export class McpValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpValidationError";
  }
}

export interface McpService {
  listByAgent(agentId: string): McpServerRow[];
  create(agentId: string, input: CreateMcpServerInput): Promise<McpServerRow>;
  update(agentId: string, serverId: string, input: UpdateMcpServerInput): Promise<McpServerRow>;
  delete(agentId: string, serverId: string): Promise<void>;
}

function maskEnv(row: McpServerRow): McpServerRow {
  if (!row.env) return row;
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(row.env)) {
    masked[k] = v.length > 4 ? `****${v.slice(-4)}` : "****";
  }
  return { ...row, env: masked };
}

export function createMcpService(deps: {
  port: McpServerPort;
  mcpClientManager: McpClientManager;
  agentExists: (id: string) => Promise<boolean>;
  idGen?: () => string;
}): McpService {
  const idGen = deps.idGen ?? ulid;

  function require(serverId: string): McpServerRow {
    const r = deps.port.getById(serverId);
    if (!r) throw new McpServerNotFoundError(serverId);
    return r;
  }

  return {
    listByAgent(agentId: string): McpServerRow[] {
      return deps.port
        .listByAgent(agentId)
        .map(maskEnv)
        .map((row) => ({
          ...row,
          status: deps.mcpClientManager.getStatus(row.serverId),
          toolsCount: deps.mcpClientManager.getToolCount(row.serverId),
        }));
    },

    async create(agentId: string, input: CreateMcpServerInput): Promise<McpServerRow> {
      if (!(await deps.agentExists(agentId))) {
        throw new McpValidationError(`Agent not found: ${agentId}`);
      }
      const now = Date.now();
      const serverId = idGen();
      const row = deps.port.create({
        serverId,
        agentId,
        name: input.name,
        transport: input.transport,
        command: input.command ?? null,
        args: input.args ? JSON.stringify(input.args) : "[]",
        env: input.env ? JSON.stringify(input.env) : "{}",
        url: input.url ?? null,
        enabled: input.enabled !== false ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      });

      if (row.enabled) {
        deps.mcpClientManager
          .connect({
            serverId: row.serverId,
            agentId: row.agentId,
            name: row.name,
            transport: row.transport,
            command: row.command ?? undefined,
            args: row.args ?? undefined,
            env: row.env ?? undefined,
            url: row.url ?? undefined,
            enabled: row.enabled,
          })
          .catch(() => {});
      }

      return maskEnv(row);
    },

    async update(
      _agentId: string,
      serverId: string,
      input: UpdateMcpServerInput,
    ): Promise<McpServerRow> {
      require(serverId); // throws if not found

      const sets: Record<string, unknown> = {};
      if (input.name !== undefined) sets.name = input.name;
      if (input.command !== undefined) sets.command = input.command;
      if (input.args !== undefined) sets.args = JSON.stringify(input.args);
      if (input.env !== undefined) sets.env = JSON.stringify(input.env);
      if (input.url !== undefined) sets.url = input.url;
      if (input.enabled !== undefined) sets.enabled = input.enabled ? 1 : 0;

      const updated = deps.port.update(serverId, { ...sets, updatedAt: Date.now() });
      if (!updated) throw new McpServerNotFoundError(serverId);

      // Disconnect old, reconnect with fresh config — sequenced, not raced
      void (async () => {
        try {
          await deps.mcpClientManager.disconnect(serverId);
        } catch {
          // best-effort, carry on
        }
        if (updated.enabled) {
          try {
            await deps.mcpClientManager.connect({
              serverId: updated.serverId,
              agentId: updated.agentId,
              name: updated.name,
              transport: updated.transport,
              command: updated.command ?? undefined,
              args: updated.args ?? undefined,
              env: updated.env ?? undefined,
              url: updated.url ?? undefined,
              enabled: updated.enabled,
            });
          } catch {
            // degraded mode handles empty tools
          }
        }
      })();

      return { ...maskEnv(updated), status: deps.mcpClientManager.getStatus(updated.serverId) };
    },

    async delete(_agentId: string, serverId: string): Promise<void> {
      require(serverId);
      deps.mcpClientManager.disconnect(serverId).catch(() => {});
      if (!deps.port.delete(serverId)) throw new McpServerNotFoundError(serverId);
    },
  };
}
