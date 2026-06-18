/** Issue — a work unit with its own state-machine lifecycle, spanning
 *  multiple runs on a single bound thread. The only new domain ontology in M18. */
export interface IssueRow {
  issueId: string;
  projectId: string;
  title: string;
  status: IssueStatus;
  /** The thread this Issue runs on. Reuses the existing run载体, no new exec mechanism. */
  threadId: string;
  createdAt: number;
  updatedAt: number;
}

export type IssueStatus = "planned" | "in_progress" | "in_review" | "done";

// M18.2: TRANSITIONS / deriveStatuses / deriveLegalMap / ISSUE_STATUSES / LEGAL_TRANSITIONS
// moved to ../orchestrator/transitions.js — the single source of truth for the state space.
