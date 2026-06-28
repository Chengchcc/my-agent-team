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

// ControlPlaneEventKind narrowed to only the 3 values actually emitted (S3 storage convergence).
// The 12 removed values were runner/reattach-era vocabulary never written to the database.
export type ControlPlaneEventKind =
  | "projection_degraded" // supervisor.ts:157 — critical sink (ledger terminal write) failed
  | "retry_requested" // scheduler.ts:139
  | "retry_started"; // scheduler.ts:152

export interface ControlPlaneEvent {
  seq: number;
  spanId: string;
  attemptSeq: number | null;
  kind: ControlPlaneEventKind;
  payload: Record<string, unknown>;
  traceId: string | null;
  ts: number;
}

/** M19: Explicit run cause — replaces implicit inference from surface + issueId combo. */
export type SpanOriginKind = "orchestrator" | "mention" | "manual" | "cron";

export interface SpanOriginRow {
  spanId: string;
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
  originKind: SpanOriginKind;
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
