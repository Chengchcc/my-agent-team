import type { AgentRow, CreateAgentInput, UpdateAgentInput } from "./domain.js";
import type { AgentPort } from "./ports.js";

export interface AgentService {
  create(input: CreateAgentInput): Promise<AgentRow>;
  getById(id: string): Promise<AgentRow>;
  list(includeArchived?: boolean): Promise<AgentRow[]>;
  update(id: string, input: UpdateAgentInput): Promise<AgentRow>;
  archive(id: string): Promise<AgentRow>;
  /** M11: Permanently delete agent across backend.db + events.db + workspace. Requires no active runs. */
  hardDelete(id: string): Promise<void>;
}

export function createAgentService(opts: {
  port: AgentPort;
  idGen: () => string;
  workspaceRoot: string;
  materializeWorkspace: (agentId: string, template?: string) => Promise<string>;
  /** M11: Purge workspace directory. Injected to keep service testable. */
  purgeWorkspace?: (agentId: string) => Promise<void>;
  /** M11: Check if agent has active runs (events.db query). Returns true if active runs exist. */
  hasActiveRuns?: (agentId: string) => Promise<boolean>;
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

    // M11: Hard delete with active-guard check immediately before deletion
    async hardDelete(id: string): Promise<void> {
      // Guard: check events.db for active attempts right before delete (minimize TOCTOU window)
      if (opts.hasActiveRuns) {
        const active = await opts.hasActiveRuns(id);
        if (active) throw new AgentBusyError(id);
      }

      // Delete from backend.db (transactional)
      await port.hardDelete(id);

      // Purge workspace (physical, idempotent)
      if (opts.purgeWorkspace) {
        await opts.purgeWorkspace(id);
      }
    },
  };
}

export class AgentNotFoundError extends Error {
  constructor(id: string) {
    super(`Agent not found: ${id}`);
    this.name = "AgentNotFoundError";
  }
}

export class AgentBusyError extends Error {
  constructor(id: string) {
    super(`Agent has active runs: ${id}`);
    this.name = "AgentBusyError";
  }
}
