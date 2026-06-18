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

/** Physical attempt — one per subprocess fork. */
export interface AttemptRow {
  attemptId: string;
  runId: string;
  pid: number | null;
  heartbeatAt: number | null;
  startedAt: number;
  endedAt: number | null;
}
