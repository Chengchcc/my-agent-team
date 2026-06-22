/** Issue — a work unit with its own state-machine lifecycle, spanning
 *  multiple runs on a single bound thread. The only new domain ontology in M18. */
export interface IssueRow {
  issueId: string;
  projectId: string;
  title: string;
  status: IssueStatus;
  /** The thread this Issue runs on. Reuses the existing run载体, no new exec mechanism. */
  threadId: string;
  /** M19: Human-readable description (empty = not filled in). */
  description: string;
  /** M19: Priority level — P0 (critical) through P3 (low). */
  priority: IssuePriority;
  /** M19: Estimated completion timestamp (null = not filled in). */
  estimatedCompletionAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type IssueStatus = "draft" | "planned" | "in_progress" | "in_review" | "done";

/** M19: Issue priority — P0 red, P1 orange, P2 blue, P3 gray. */
export type IssuePriority = "P0" | "P1" | "P2" | "P3";
export const ISSUE_PRIORITIES: readonly IssuePriority[] = ["P0", "P1", "P2", "P3"];

// M18.2: TRANSITIONS / deriveStatuses / deriveLegalMap / ISSUE_STATUSES / LEGAL_TRANSITIONS
// moved to ../orchestrator/transitions.js — the single source of truth for the state space.
