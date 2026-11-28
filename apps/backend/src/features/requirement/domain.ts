/** ADR 0074: the requirement (事项) domain. */

export type RequirementStoredStatus = "open" | "done" | "cancelled";

/** The derived read-model status: everything between open and done comes from
 *  execution and pending-request records, never from editing a summary. */
export type RequirementViewStatus =
  | RequirementStoredStatus
  | "in_progress"
  | "waiting_user"
  | "pending_acceptance";

export interface RequirementRow {
  requirementId: string;
  /** What the person accepted, as `run:<id> <verdict>` references. */
  acceptedEvidence: readonly string[] | null;
  acceptedAt: number | null;
  title: string;
  goal: string;
  background: string | null;
  constraints: string | null;
  expectedDeliverables: string | null;
  acceptanceCriteria: string | null;
  status: RequirementStoredStatus;
  /** ADR 0074: the project the goal belongs to (null = none / unknown). */
  projectId: string | null;
  originConversationId: string | null;
  originSeq: number | null;
  createdByAgentId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** What the PA may write through the tool. Fields are optional so an update
 *  touches only what it names; `title`/`goal` are required on CREATE. */
export interface RequirementPatch {
  title?: string;
  goal?: string;
  background?: string | null;
  constraints?: string | null;
  expectedDeliverables?: string | null;
  acceptanceCriteria?: string | null;
  status?: RequirementStoredStatus;
  projectId?: string | null;
  /** Set by the acceptance path (a person marking the item done). */
  acceptedEvidence?: string[] | null;
  acceptedAt?: number | null;
}

export interface RequirementRunFact {
  runId: string;
  agentId: string | null;
  status: string;
  /** The run's recorded verification verdict, when it reached a terminal. */
  verification: string | null;
  createdAt: number;
}

export interface RequirementRequestFact {
  actionId: string;
  runId: string;
  kind: string;
  status: string;
  head: string;
  /** Who owes the answer. `user` (or unset, for rows that predate the column)
   *  is the only owner that makes the item "waiting for you" (audit N2). */
  owner?: string | null;
}

export interface RequirementWorkflowFact {
  executionId: string;
  workflowId: string;
  status: string;
  createdAt: number;
  terminalAt: number | null;
}

export interface RequirementView {
  requirement: RequirementRow;
  derivedStatus: RequirementViewStatus;
  runs: readonly RequirementRunFact[];
  requests: readonly RequirementRequestFact[];
  workflowExecutions?: readonly RequirementWorkflowFact[];
}

/** Derive the view status. Ordered questions, first hit wins:
 *  a stored terminal beats everything; an unresolved human request or parked
 *  workflow human gate means waiting; a live run or running workflow means
 *  in_progress; a passed verification means acceptance is the only thing left. */
export function deriveRequirementStatus(
  stored: RequirementStoredStatus,
  runs: readonly RequirementRunFact[],
  requests: readonly RequirementRequestFact[],
  workflowExecutions: readonly RequirementWorkflowFact[] = [],
): RequirementViewStatus {
  if (stored === "done" || stored === "cancelled") return stored;
  // The attention headline outranks "work in flight": a run parked on a human
  // answer (or a workflow parked at a human gate) is WAITING FOR THE USER.
  const blocking =
    requests.some((r) => r.status === "pending" && (r.owner ?? "user") === "user") ||
    workflowExecutions.some((w) => w.status === "waiting_human");
  if (blocking) return "waiting_user";
  const live =
    runs.some((r) => r.status === "running" || r.status === "waiting") ||
    workflowExecutions.some((w) => w.status === "running");
  if (live) return "in_progress";
  const executed = runs.length > 0 && runs.every((r) => isTerminal(r.status));
  if (executed) {
    // Acceptance is about the CURRENT attempt: a passed check from an old run
    // must not mark the item accepted-ready after a later attempt failed
    // (audit N2: 12 completed + 1 aborted read as in_progress, and the reverse
    // — one old pass over a newer failure — read as ready).
    const latest = [...runs].sort((a, b) => b.createdAt - a.createdAt)[0];
    if (latest?.verification === "passed") return "pending_acceptance";
    return "in_progress";
  }
  return "open";
}

export function isTerminal(status: string): boolean {
  return (
    status === "completed" || status === "failed" || status === "aborted" || status === "timeout"
  );
}
