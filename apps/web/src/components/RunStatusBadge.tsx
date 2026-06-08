import { Badge } from "@/components/ui/badge";

const STATUS_MAP: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  running: { label: "Running", variant: "default" },
  succeeded: { label: "Done", variant: "outline" },
  error: { label: "Error", variant: "destructive" },
  aborted: { label: "Aborted", variant: "secondary" },
  interrupted: { label: "Waiting approval", variant: "secondary" },
  connecting: { label: "Connecting...", variant: "outline" },
  streaming: { label: "Streaming", variant: "default" },
  done: { label: "Done", variant: "outline" },
  idle: { label: "Idle", variant: "outline" },
};

export function RunStatusBadge({ status }: { status: string }) {
  const info = STATUS_MAP[status] ?? {
    label: status,
    variant: "outline" as const,
  };
  return <Badge variant={info.variant}>{info.label}</Badge>;
}
