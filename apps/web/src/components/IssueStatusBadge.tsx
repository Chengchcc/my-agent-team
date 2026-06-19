import { Badge } from "@/components/ui/badge";
import type { IssueStatus } from "@/lib/api";

const STATUS_MAP: Record<
  IssueStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  draft: { label: "草稿", variant: "secondary" },
  planned: { label: "计划中", variant: "secondary" },
  in_progress: { label: "开发中", variant: "default" },
  in_review: { label: "待 Review", variant: "secondary" },
  done: { label: "已完成", variant: "outline" },
};

export function IssueStatusBadge({ status }: { status: IssueStatus }) {
  const info = STATUS_MAP[status] ?? { label: status, variant: "outline" as const };
  return <Badge variant={info.variant}>{info.label}</Badge>;
}
