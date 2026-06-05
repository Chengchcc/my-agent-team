import type { CreateThreadInput, ThreadRow } from "./domain.js";
import type { ThreadPort } from "./ports.js";

export class ThreadNotFoundError extends Error {
  constructor(id: string) {
    super(`Thread not found: ${id}`);
    this.name = "ThreadNotFoundError";
  }
}

export class AgentNotFoundForThreadError extends Error {
  constructor(id: string) {
    super(`Agent not found: ${id}`);
    this.name = "AgentNotFoundForThreadError";
  }
}

export function createThreadService(opts: {
  port: ThreadPort;
  idGen: () => string;
  agentExists: (agentId: string) => Promise<boolean>;
  cleanupCheckpoint: (threadId: string) => Promise<void>;
}) {
  const { port, idGen, agentExists, cleanupCheckpoint } = opts;

  return {
    async create(agentId: string, input: CreateThreadInput): Promise<ThreadRow> {
      if (!(await agentExists(agentId))) throw new AgentNotFoundForThreadError(agentId);
      const id = idGen();
      return port.create({ ...input, id, agentId, now: Date.now() });
    },

    async getById(id: string): Promise<ThreadRow> {
      const row = port.findById(id);
      if (!row) throw new ThreadNotFoundError(id);
      return row;
    },

    async listByAgent(agentId: string): Promise<ThreadRow[]> {
      return port.listByAgent(agentId);
    },

    async update(id: string, input: { title?: string }): Promise<ThreadRow> {
      const row = port.update(id, { ...input, now: Date.now() });
      if (!row) throw new ThreadNotFoundError(id);
      return row;
    },

    async delete(id: string): Promise<void> {
      if (!port.delete(id)) throw new ThreadNotFoundError(id);
      // N3: cleanup checkpoint data after thread deletion; failure logged but not fatal
      try {
        await cleanupCheckpoint(id);
      } catch {
        /* checkpoint cleanup is best-effort */
      }
    },

    touchLastRun(id: string): void {
      port.update(id, { lastRunAt: Date.now(), now: Date.now() });
    },
  };
}
