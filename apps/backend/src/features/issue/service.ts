import { LEGAL_TRANSITIONS, type IssueRow, type IssueStatus } from "./entities.js";
import type { IssuePort } from "./ports.js";

export class IssueNotFoundError extends Error {
  constructor(id: string) {
    super(`Issue not found: ${id}`);
    this.name = "IssueNotFoundError";
  }
}

export class IllegalTransitionError extends Error {
  constructor(msg: string) {
    super(`Illegal transition: ${msg}`);
    this.name = "IllegalTransitionError";
  }
}

export interface IssueServiceDeps {
  port: IssuePort;
  idGen: () => string;
  now?: () => number;
}

export function createIssueService(deps: IssueServiceDeps) {
  const { port, idGen } = deps;
  const now = deps.now ?? Date.now;

  return {
    port,

    createIssue(input: { projectId: string; title: string; threadId: string }): IssueRow {
      return port.createIssue({
        issueId: idGen(),
        projectId: input.projectId,
        title: input.title,
        threadId: input.threadId,
        createdAt: now(),
      });
    },

    applyTransition(issueId: string, to: IssueStatus): IssueRow {
      const issue = port.getIssue(issueId);
      if (!issue) throw new IssueNotFoundError(issueId);
      const legal = LEGAL_TRANSITIONS[issue.status] ?? [];
      if (!legal.includes(to)) throw new IllegalTransitionError(`${issue.status} → ${to}`);
      const ts = now();
      const ok = port.setStatus(issueId, issue.status, to, ts);
      if (!ok) throw new IllegalTransitionError(`${issue.status} → ${to} (lost CAS)`);
      return { ...issue, status: to, updatedAt: ts };
    },
  };
}

export type IssueService = ReturnType<typeof createIssueService>;
