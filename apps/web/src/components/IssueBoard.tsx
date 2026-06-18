import type { IssueRow, IssueStatus } from "@/lib/api";
import { IssueCard } from "./IssueCard";

const COLUMN_LABEL: Record<IssueStatus, string> = {
  planned: "计划中",
  in_progress: "开发中",
  in_review: "待 Review",
  done: "已完成",
};

export function IssueBoard({ statuses, issues }: { statuses: IssueStatus[]; issues: IssueRow[] }) {
  // meta 失败时光降级为平铺列表（不分列），避免有效数据被错误态藏掉
  if (statuses.length === 0) {
    if (issues.length === 0)
      return <div className="p-6 text-sm text-muted-foreground">暂无 Issue</div>;
    return (
      <div className="p-6 space-y-3">
        {issues.map((it) => (
          <IssueCard key={it.issueId} issue={it} />
        ))}
      </div>
    );
  }

  // 手动分组（替代 ES2024 的 Object.groupBy）
  const byStatus = new Map<IssueStatus, IssueRow[]>(statuses.map((s) => [s, []]));
  for (const it of issues) byStatus.get(it.status)?.push(it);

  return (
    <div className="flex gap-4 p-6 overflow-x-auto">
      {statuses.map((s) => (
        <section key={s} className="w-72 shrink-0">
          <h2 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
            {COLUMN_LABEL[s] ?? s} ({byStatus.get(s)?.length ?? 0})
          </h2>
          <div className="space-y-2">
            {(byStatus.get(s) ?? []).map((it) => (
              <IssueCard key={it.issueId} issue={it} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
