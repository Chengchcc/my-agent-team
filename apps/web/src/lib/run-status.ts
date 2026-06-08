export type RunStatusLabel =
  | "Connecting"
  | "Running"
  | "Awaiting Approval"
  | "Complete"
  | "Aborted"
  | "Error"
  | null;

export function statusLabel(
  runId: string | null,
  runStatus: string | null,
  liveStatus: string,
): RunStatusLabel {
  if (!runId) return null;
  if (liveStatus === "connecting") return "Connecting";
  if (liveStatus === "streaming" || runStatus === "running") return "Running";
  if (runStatus === "interrupted") return "Awaiting Approval";
  if (runStatus === "succeeded" || liveStatus === "done") return "Complete";
  if (runStatus === "aborted") return "Aborted";
  if (runStatus === "error" || liveStatus === "error") return "Error";
  return runStatus as RunStatusLabel;
}
