// ─── M18.7 Issue Timeline types ───

export type IssueEventKind =
  | "created"
  | "started"
  | "run.started"
  | "run.ended"
  | "deliverable.submitted"
  | "status.advanced"
  | "human.decided";

export interface IssueEvent {
  seq: number;
  issueId: string;
  kind: IssueEventKind;
  payload: Record<string, unknown>;
  ts: number;
}

export type RunOpsEventKind =
  | "attempt_started"
  | "attempt_transport_seen"
  | "delta_pushed"
  | "run_done_received"
  | "run_finalized_sent"
  | "cancel_requested"
  | "abort_sent"
  | "reattach_started"
  | "reattach_succeeded"
  | "reattach_failed"
  | "reaper_marked_interrupted"
  | "projection_degraded" // P2: critical sink (ledger terminal write) failed
  | "recover_requested"
  | "retry_requested"
  | "retry_started";

export interface RunOpsEvent {
  seq: number;
  runId: string;
  /** @deprecated use attemptSeq instead */
  attemptId: string | null;
  attemptSeq: string | null;
  kind: RunOpsEventKind;
  payload: Record<string, unknown>;
  traceId: string | null;
  ts: number;
}

/** M19: Explicit run cause — replaces implicit inference from surface + issueId combo. */
export type RunOriginKind = "orchestrator" | "mention" | "manual" | "cron";

export interface RunOriginRow {
  runId: string;
  conversationId: string;
  sourceLedgerSeq: number;
  agentMemberId: string;
  surface: string;
  traceId: string;
  traceparent: string;
  idempotencyKey: string;
  /** M18.2: non-null = issue-driven run (used for Issue back-link + @mention isolation) */
  issueId?: string | null;
  /** M21: non-null = cron-driven run (back-link to cron_job + @mention isolation). */
  cronJobId?: string | null;
  /** M18.5 R3: authoritative source for the issue status at run start — no more split(":"). */
  fromStatus: string;
  /** M19: explicit run cause — orchestrator | mention | manual */
  originKind: RunOriginKind;
  createdAt: number;
}

export interface SurfaceHealthRow {
  agentId: string;
  surface: string;
  status: string;
  lastSeenAt: number | null;
  payload: string;
  lastError: string | null;
  updatedAt: number;
}
