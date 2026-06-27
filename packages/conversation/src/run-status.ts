/** Independent run lifecycle phase, not tied to message content rendering. */
export type RunPhase =
  | "queued"
  | "running"
  | "compacting"
  | "retrying"
  | "succeeded"
  | "error"
  | "interrupted";

export const TERMINAL_RUN_PHASES: ReadonlySet<RunPhase> = new Set([
  "succeeded",
  "error",
  "interrupted",
]);

export interface RunStatus {
  spanId: string;
  phase: RunPhase;
  /** Detail text for terminal phases (error message, etc.). Empty for non-terminal. */
  detail?: string;
  updatedAt: number;
}
