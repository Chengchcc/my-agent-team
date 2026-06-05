export interface RunRow {
  id: string;
  threadId: string;
  input: string;
  status: "running" | "completed" | "aborted" | "error";
  errorMessage: string | null;
  startedAt: number;
  endedAt: number | null;
}
