/** Logical run — one per user interaction, spans multiple interrupt/resume attempts. */
export interface RunRow {
  runId: string;
  threadId: string;
  status: "running" | "succeeded" | "error" | "aborted" | "interrupted";
  startedAt: number;
  endedAt: number | null;
  /** P2: non-null when the critical projection sink (ledger terminal write)
   *  failed for this run. The run status remains authoritative; this flags
   *  that the conversation ledger may be missing the terminal assistant message. */
  degradedReason?: string | null;
}

/** Physical attempt — AgentSession runs in-process, no subprocess. */
export interface AttemptRow {
  attemptId: string;
  runId: string;
  /** @deprecated AgentSession runs in-process — no longer written. Kept for historical data. */
  pid: number | null;
  /** @deprecated No daemon heartbeat — no longer written. Kept for historical data. */
  heartbeatAt: number | null;
  startedAt: number;
  endedAt: number | null;
}
