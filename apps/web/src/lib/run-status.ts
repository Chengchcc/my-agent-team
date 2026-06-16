export type RunPhase = "idle" | "running" | "interrupted" | "done" | "error";

export type RunStatusLabel =
  | "Connecting"
  | "Running"
  | "Awaiting Approval"
  | "Complete"
  | "Aborted"
  | "Error"
  | null;

export function computeStatus(runId: string | null, phase: RunPhase): RunStatusLabel {
  if (!runId) return null;
  switch (phase) {
    case "running":
      return "Running";
    case "interrupted":
      return "Awaiting Approval";
    case "done":
      return "Complete";
    case "error":
      return "Error";
    default:
      return null;
  }
}
