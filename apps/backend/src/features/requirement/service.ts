import type { RequirementPort } from "./adapter-sqlite.js";
import {
  deriveRequirementStatus,
  type RequirementPatch,
  type RequirementRow,
  type RequirementView,
} from "./domain.js";

export class RequirementNotFoundError extends Error {
  constructor(id: string) {
    super(`requirement not found: ${id}`);
  }
}

export interface RequirementService {
  /** Create from the PA's tool call. Title and goal are required — a goal
   *  without a stated "done" is a chat note, not a tracked item. */
  create(input: {
    title: string;
    goal: string;
    background?: string | null;
    constraints?: string | null;
    expectedDeliverables?: string | null;
    acceptanceCriteria?: string | null;
    originConversationId?: string | null;
    originSeq?: number | null;
    createdByAgentId?: string | null;
  }): RequirementRow;
  update(id: string, patch: RequirementPatch): RequirementRow;
  get(id: string): RequirementView;
  list(includeClosed: boolean): RequirementRow[];
  /** ADR 0074: the dispatch tool links a worker run to a requirement. With no
   *  id given, the newest OPEN item of this conversation is continued — the
   *  "one long conversation, many goals" case — and with none open, the brief
   *  itself becomes a new item (a dispatch always has a goal). */
  resolveForDispatch(input: {
    requirementId?: string;
    conversationId: string;
    agentId: string;
    briefTitle: string;
    briefGoal: string;
    acceptance?: string | null;
  }): RequirementRow;
}

export function createRequirementService(deps: {
  port: RequirementPort;
  idGen: () => string;
  now?: () => number;
}): RequirementService {
  const now = deps.now ?? Date.now;
  return {
    create(input) {
      return deps.port.create({
        requirementId: deps.idGen(),
        title: input.title,
        goal: input.goal,
        background: input.background ?? null,
        constraints: input.constraints ?? null,
        expectedDeliverables: input.expectedDeliverables ?? null,
        acceptanceCriteria: input.acceptanceCriteria ?? null,
        status: "open",
        originConversationId: input.originConversationId ?? null,
        originSeq: input.originSeq ?? null,
        createdByAgentId: input.createdByAgentId ?? null,
        createdAt: now(),
        updatedAt: now(),
      });
    },
    update(id, patch) {
      const row = deps.port.update(id, patch, now());
      if (!row) throw new RequirementNotFoundError(id);
      return row;
    },
    get(id) {
      const requirement = deps.port.get(id);
      if (!requirement) throw new RequirementNotFoundError(id);
      const runs = deps.port.runsOf(id);
      const requests = deps.port.requestsOf(id);
      return {
        requirement,
        derivedStatus: deriveRequirementStatus(requirement.status, runs, requests),
        runs,
        requests,
      };
    },
    list(includeClosed) {
      return deps.port.list(includeClosed);
    },
    resolveForDispatch(input) {
      if (input.requirementId !== undefined && input.requirementId !== "") {
        const named = deps.port.get(input.requirementId);
        if (!named) throw new RequirementNotFoundError(input.requirementId);
        return named;
      }
      const open = deps.port.listOpenByConversation(input.conversationId, 1);
      if (open.length > 0) return open[0]!;
      return this.create({
        title: input.briefTitle,
        goal: input.briefGoal,
        acceptanceCriteria: input.acceptance ?? null,
        originConversationId: input.conversationId,
        createdByAgentId: input.agentId,
      });
    },
  };
}
