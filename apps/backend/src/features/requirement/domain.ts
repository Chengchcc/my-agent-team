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
}

export interface RequirementView {
  requirement: RequirementRow;
  derivedStatus: RequirementViewStatus;
  runs: readonly RequirementRunFact[];
  requests: readonly RequirementRequestFact[];
}

/** Derive the view status. Ordered questions, first hit wins:
 *  a stored terminal beats everything; a live run means work; an unresolved
 *  human request means waiting; a passed verification means acceptance is the
 *  only thing left. */
export function deriveRequirementStatus(
  stored: RequirementStoredStatus,
  runs: readonly RequirementRunFact[],
  requests: readonly RequirementRequestFact[],
): RequirementViewStatus {
  if (stored === "done" || stored === "cancelled") return stored;
  // The attention headline outranks "work in flight": a run parked on a human
  // answer is WAITING FOR THE USER even while it is the live run.
  const blocking = requests.some((r) => r.status === "pending");
  if (blocking) return "waiting_user";
  const live = runs.some((r) => r.status === "running" || r.status === "waiting");
  if (live) return "in_progress";
  const executed = runs.length > 0 && runs.every((r) => isTerminal(r.status));
  if (executed && runs.some((r) => r.verification === "passed")) return "pending_acceptance";
  if (executed) return "in_progress";
  return "open";
}

export function isTerminal(status: string): boolean {
  return (
    status === "completed" || status === "failed" || status === "aborted" || status === "timeout"
  );
}
