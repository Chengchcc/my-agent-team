import { LEGAL_TRANSITIONS } from "../orchestrator/transitions.js";
import type { IssueRow, IssueStatus } from "./entities.js";
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

export class ValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ValidationError";
  }
}

export interface IssueServiceDeps {
  port: IssuePort;
  idGen: () => string;
  now?: () => number;
  /** 可选：校验 threadId 是否真实存在。不存在则抛 ValidationError → 400。 */
  threadExists?: (threadId: string) => boolean;
  /** 可选：校验 projectId 是否真实存在。不存在则抛 ValidationError → 400。 */
  projectExists?: (projectId: string) => boolean;
}

export function createIssueService(deps: IssueServiceDeps) {
  const { port, idGen, threadExists, projectExists } = deps;
  const now = deps.now ?? Date.now;

  return {
    port,

    createIssue(input: { projectId: string; title: string; threadId: string }): IssueRow {
      if (threadExists && !threadExists(input.threadId)) {
        throw new ValidationError(`thread not found: ${input.threadId}`);
      }
      if (projectExists && !projectExists(input.projectId)) {
        throw new ValidationError(`project not found: ${input.projectId}`);
      }
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
      // 写后重读：保证返回对象等于库内真值，为 M18.2 多列写入预留
      return port.getIssue(issueId)!;
    },
  };
}

export type IssueService = ReturnType<typeof createIssueService>;
