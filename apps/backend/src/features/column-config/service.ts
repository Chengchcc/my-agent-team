import type { Transition } from "../orchestrator/transitions.js";
import type { IssueStatus } from "../issue/entities.js";
import type { ColumnConfigPort } from "./ports.js";
import type { ColumnConfigRow } from "./domain.js";

export class ColumnConfigNotFoundError extends Error {
  constructor(id: string) {
    super(`ColumnConfig not found: ${id}`);
    this.name = "ColumnConfigNotFoundError";
  }
}

export class ValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ValidationError";
  }
}

/** Fixed lifecycle order — all Projects share this topology.
 *  Only "who does each step" varies per Project via ColumnConfig. */
export const ORDER: IssueStatus[] = ["draft", "planned", "in_progress", "in_review", "done"];

export interface ColumnConfigServiceDeps {
  port: ColumnConfigPort;
  idGen: () => string;
  agentExists: (id: string) => Promise<boolean>;
  now?: () => number;
}

export function createColumnConfigService(deps: ColumnConfigServiceDeps) {
  const { port, idGen, agentExists } = deps;
  const now = deps.now ?? Date.now;

  return {
    port,

    listByProject(projectId: string): ColumnConfigRow[] {
      return port.listByProject(projectId);
    },

    async upsert(input: {
      projectId: string;
      status: IssueStatus;
      agentId: string;
      promptTemplate: string;
    }): Promise<ColumnConfigRow> {
      if (!(await agentExists(input.agentId))) {
        throw new ValidationError(`agent not found or archived: ${input.agentId}`);
      }
      const existing = port.getByProjectStatus(input.projectId, input.status);
      return port.upsert({
        configId: existing?.configId ?? idGen(),
        projectId: input.projectId,
        status: input.status,
        agentId: input.agentId,
        promptTemplate: input.promptTemplate,
        now: now(),
      });
    },

    remove(configId: string): void {
      if (!port.delete(configId)) throw new ColumnConfigNotFoundError(configId);
    },

    /**
     * Derive the Transition[] for a given Project from its ColumnConfig rows.
     * Only steps that have a ColumnConfig are auto-advanceable by the reactor.
     * draft→planned is intentionally excluded (no ColumnConfig for draft) —
     * it's triggered by manual drag, not by the reactor.
     */
    transitionsForProject(projectId: string): Transition[] {
      const byStatus = new Map(port.listByProject(projectId).map((c) => [c.status, c]));
      const out: Transition[] = [];
      for (let i = 0; i < ORDER.length - 1; i++) {
        const from = ORDER[i]!;
        const to = ORDER[i + 1]!;
        const cfg = byStatus.get(from);
        if (!cfg) continue;
        out.push({ from, to, agentId: cfg.agentId, promptTemplate: cfg.promptTemplate });
      }
      return out;
    },
  };
}

export type ColumnConfigService = ReturnType<typeof createColumnConfigService>;
