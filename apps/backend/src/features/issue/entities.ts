import type { IssuePriority, IssueStatus } from "@my-agent-team/api-contract";

export type { IssuePriority, IssueStatus } from "@my-agent-team/api-contract";
export { ISSUE_PRIORITIES } from "@my-agent-team/api-contract";

/** Issue — a work unit with its own state-machine lifecycle, spanning
 *  multiple runs on a single bound thread. The only new domain ontology in M18. */
export interface IssueRow {
  issueId: string;
  projectId: string;
  title: string;
  status: IssueStatus;
  /** Session this Issue runs on (= conversationId). */
  sessionId: string;
  /** M19: Human-readable description (empty = not filled in). */
  description: string;
  /** M19: Priority level — P0 (critical) through P3 (low). */
  priority: IssuePriority;
  /** M19: Estimated completion timestamp (null = not filled in). */
  estimatedCompletionAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// M18.2: TRANSITIONS / deriveStatuses / deriveLegalMap / ISSUE_STATUSES / LEGAL_TRANSITIONS
// moved to ../orchestrator/transitions.js — the single source of truth for the state space.
