import type { AgentRow, CreateAgentInput, UpdateAgentInput } from "./domain.js";
import type { AgentPort } from "./ports.js";

export interface AgentService {
  create(input: CreateAgentInput): Promise<AgentRow>;
  getById(id: string): Promise<AgentRow>;
  /** Check if an agent exists and is not archived. Single-row lookup, no full scan. */
  exists(id: string): Promise<boolean>;
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
  // M11 hardDelete dependencies — all closures from composition root (main.ts)
  purgeWorkspace: (agentId: string) => Promise<void>;
  purgeEventsForSessions: (sessionIds: string[]) => Promise<void>;
  listSessionIds: (agentId: string) => Promise<string[]>;
  assertNoActiveRun: (agentId: string) => void;
}): AgentService {
  const { port, idGen, materializeWorkspace } = opts;

  return {
    async create(input: CreateAgentInput): Promise<AgentRow> {
      const id = idGen();
      const workspacePath = await materializeWorkspace(id, input.template);
      const now = Date.now();
      const larkEnabled = input.lark?.enabled ?? false;
      const larkAppId = input.lark?.appId ?? null;
      const larkProfileRef = larkEnabled ? `agent:${id}` : null;
      const larkBotDisplayName = input.lark?.botDisplayName ?? null;
      return port.create({
        ...input,
        id,
        workspacePath,
        now,
        larkEnabled,
        larkAppId,
        larkProfileRef,
        larkBotDisplayName,
      });
    },

    async getById(id: string): Promise<AgentRow> {
      const row = await port.findById(id);
      if (!row || row.archivedAt) throw new AgentNotFoundError(id);
      return row;
    },

    async exists(id: string): Promise<boolean> {
      const row = await port.findById(id);
      return row !== null && row.archivedAt == null;
    },

    async list(includeArchived = false): Promise<AgentRow[]> {
      return port.list(includeArchived);
    },

    async update(id: string, input: UpdateAgentInput): Promise<AgentRow> {
      // Auto-generate larkProfileRef when enabling lark on an agent without one
      if (input.lark?.enabled) {
        const existing = await port.findById(id);
        if (existing && !existing.larkProfileRef) {
          const updateWithProfile = {
            ...input,
            lark: { ...input.lark, profileRef: `agent:${id}` },
          };
          const row = await port.update(id, { ...updateWithProfile, now: Date.now() });
          if (!row) throw new AgentNotFoundError(id);
          return row;
        }
      }
      const row = await port.update(id, { ...input, now: Date.now() });
      if (!row) throw new AgentNotFoundError(id);
      return row;
    },

    async archive(id: string): Promise<AgentRow> {
      const row = await port.archive(id, Date.now());
      if (!row) throw new AgentNotFoundError(id);
      return row;
    },

    // M11: Hard delete across three stores — backend.db (transactional), events.db, workspace
    async hardDelete(id: string): Promise<void> {
      // 0. Verify agent exists (throws AgentNotFoundError if not)
      await this.getById(id);

      // 1. Guard: assert no active runs (throws AgentBusyError if busy)
      opts.assertNoActiveRun(id);

      // 2. Collect thread IDs for events.db cleanup
      const sessionIds = await opts.listSessionIds(id);

      // 3. backend.db: single transaction — agent + threads + checkpoint + member
      await port.hardDelete(id);

      // 4. events.db: purge run/attempt/event_log for this agent's threads
      await opts.purgeEventsForSessions(sessionIds);

      // 5. workspace: physical rm -rf (idempotent)
      await opts.purgeWorkspace(id);
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
