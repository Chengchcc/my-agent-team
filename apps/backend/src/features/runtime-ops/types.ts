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
  attemptId: string | null;
  kind: RunOpsEventKind;
  payload: Record<string, unknown>;
  traceId: string | null;
  ts: number;
}

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
  /** M18.5 R3: authoritative source for the issue status at run start — no more split(":"). */
  fromStatus: string;
  createdAt: number;
}

export interface RunnerHealthRow {
  agentId: string;
  lastSeenAt: number | null;
  uptimeMs: number;
  activeRunCount: number;
  activeRunIds: string;
  checkpointerOk: number;
  workspaceOk: number;
  lastError: string | null;
  updatedAt: number;
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

export type RunnerHealthStatus = "idle" | "busy" | "degraded" | "offline" | "unknown";

export function computeRunnerStatus(
  row: RunnerHealthRow | undefined,
  now: number,
  offlineAfterMs: number,
): RunnerHealthStatus {
  if (!row) return "unknown";
  if (!row.lastSeenAt || now - row.lastSeenAt > offlineAfterMs) return "offline";
  if (!row.checkpointerOk || !row.workspaceOk || row.lastError) return "degraded";
  return row.activeRunCount > 0 ? "busy" : "idle";
}
