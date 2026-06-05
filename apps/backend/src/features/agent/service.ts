import type { AgentRow, CreateAgentInput, UpdateAgentInput } from "./domain.js";
import type { AgentPort } from "./ports.js";

export interface AgentService {
  create(input: CreateAgentInput): Promise<AgentRow>;
  getById(id: string): Promise<AgentRow>;
  list(includeArchived?: boolean): Promise<AgentRow[]>;
  update(id: string, input: UpdateAgentInput): Promise<AgentRow>;
  archive(id: string): Promise<AgentRow>;
}

export function createAgentService(opts: {
  port: AgentPort;
  idGen: () => string;
  workspaceRoot: string;
  materializeWorkspace: (agentId: string, template?: string) => Promise<string>;
}): AgentService {
  const { port, idGen, materializeWorkspace } = opts;

  return {
    async create(input: CreateAgentInput): Promise<AgentRow> {
      const id = idGen();
      const workspacePath = await materializeWorkspace(id, input.template);
      const now = Date.now();
      return port.create({ ...input, id, workspacePath, now });
    },

    async getById(id: string): Promise<AgentRow> {
      const row = await port.findById(id);
      if (!row || row.archivedAt) throw new AgentNotFoundError(id);
      return row;
    },

    async list(includeArchived = false): Promise<AgentRow[]> {
      return port.list(includeArchived);
    },

    async update(id: string, input: UpdateAgentInput): Promise<AgentRow> {
      const row = await port.update(id, { ...input, now: Date.now() });
      if (!row) throw new AgentNotFoundError(id);
      return row;
    },

    async archive(id: string): Promise<AgentRow> {
      const row = await port.archive(id, Date.now());
      if (!row) throw new AgentNotFoundError(id);
      return row;
    },
  };
}

export class AgentNotFoundError extends Error {
  constructor(id: string) {
    super(`Agent not found: ${id}`);
    this.name = "AgentNotFoundError";
  }
}
