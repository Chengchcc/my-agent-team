import { LEGAL_TRANSITIONS } from "../orchestrator/transitions.js";
import type { IssuePriority, IssueRow, IssueStatus } from "./entities.js";
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
  /** 可选：校验 projectId 是否真实存在。不存在则抛 ValidationError → 400。 */
  projectExists?: (projectId: string) => boolean;
}

export function createIssueService(deps: IssueServiceDeps) {
  const { port, idGen, projectExists } = deps;
  const now = deps.now ?? Date.now;

  return {
    port,

    createIssue(input: {
      projectId: string;
      title: string;
      description?: string;
      priority?: IssuePriority;
      estimatedCompletionAt?: number | null;
    }): IssueRow {
      if (projectExists && !projectExists(input.projectId)) {
        throw new ValidationError(`project not found: ${input.projectId}`);
      }
      const issueId = idGen();
      // M19: threadId uses conversation format (<conversationId>:<memberId>)
      // instead of "issue:" prefix — so issue runs flow through projection.
      const threadId = `${issueId}:owner`;
      return port.createIssue({
        issueId,
        projectId: input.projectId,
        title: input.title,
        threadId,
        description: input.description,
        priority: input.priority,
        estimatedCompletionAt: input.estimatedCompletionAt,
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

    /** 补偿性回滚：仅用于 reject 起棒失败的回退。绕过 LEGAL_TRANSITIONS
     * （in_progress→in_review 是反向边、不在合法集里），CAS 以 in_progress 为
     * 前置，防止与其它并发转移竞争。
     * 前置条件：Issue 必须存在且当前 status 为 in_progress（双层防御）。 */
    revertReviewReject(issueId: string): IssueRow {
      const issue = port.getIssue(issueId);
      if (!issue) throw new IssueNotFoundError(issueId);
      if (issue.status !== "in_progress") {
        throw new IllegalTransitionError(`revert requires in_progress, issue is ${issue.status}`);
      }
      const ts = now();
      const ok = port.setStatus(issueId, "in_progress", "in_review", ts);
      if (!ok) throw new IllegalTransitionError(`revert in_progress → in_review (lost CAS)`);
      return port.getIssue(issueId)!;
    },

    // ─── M19: Update / Delete ─────────────────────────

    updateIssue(issueId: string, patch: {
      title?: string;
      description?: string;
      priority?: IssuePriority;
      estimatedCompletionAt?: number | null;
    }): IssueRow {
      const updated = port.updateIssue(issueId, patch, now());
      if (!updated) throw new IssueNotFoundError(issueId);
      return updated;
    },

    deleteIssue(issueId: string): void {
      if (!port.deleteIssue(issueId)) throw new IssueNotFoundError(issueId);
    },

    // ─── SSE subscription ─────────────────────────────

    async *subscribeIssues(opts?: {
      signal?: AbortSignal;
      pollMs?: number;
    }): AsyncIterable<IssueRow | { _heartbeat: true }> {
      const pollMs = opts?.pollMs ?? 500;
      const lastUpdated = new Map<string, number>();
      let silentPolls = 0;
      const heartbeatInterval = 30; // ~15s at 500ms poll

      // First, yield all existing issues (catch-up)
      const initial = port.listIssues();
      for (const issue of initial) {
        yield issue;
        lastUpdated.set(issue.issueId, issue.updatedAt);
      }

      // Then long-poll for changes
      while (true) {
        if (opts?.signal?.aborted) break;

        const current = port.listIssues();
        let changed = false;
        for (const issue of current) {
          const prev = lastUpdated.get(issue.issueId);
          if (prev === undefined || issue.updatedAt > prev) {
            yield issue;
            changed = true;
          }
          lastUpdated.set(issue.issueId, issue.updatedAt);
        }

        if (!changed) {
          silentPolls++;
          if (silentPolls % heartbeatInterval === 0) {
            yield { _heartbeat: true };
          }
          await new Promise((r) => setTimeout(r, pollMs));
        } else {
          silentPolls = 0;
        }
      }
    },
  };
}

export type IssueService = ReturnType<typeof createIssueService>;
