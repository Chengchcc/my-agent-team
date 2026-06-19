import type { IssueRow, IssueStatus } from "@/lib/api";
import { IssueCard } from "./IssueCard";

const COLUMN_LABEL: Record<IssueStatus, string> = {
  planned: "计划中",
  in_progress: "开发中",
  in_review: "待 Review",
  done: "已完成",
};

export function IssueKanban({ statuses, issues }: { statuses: IssueStatus[]; issues: IssueRow[] }) {
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
  const unmatched: IssueRow[] = [];
  for (const it of issues) {
    const bucket = byStatus.get(it.status);
    if (bucket) bucket.push(it);
    else unmatched.push(it);
  }

  // 未知状态的 Issue 不被静默丢弃 — 收进兜底列显式提示
  const columns: readonly (IssueStatus | "unknown")[] =
    unmatched.length > 0 ? [...statuses, "unknown"] : statuses;

  return (
    <div className="flex gap-4 p-6 overflow-x-auto">
      {columns.map((s) => {
        const items = s === "unknown" ? unmatched : (byStatus.get(s) ?? []);
        return (
          <section key={s} className="w-72 shrink-0">
            <h2 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
              {s === "unknown" ? "Other" : (COLUMN_LABEL[s] ?? s)} ({items.length})
            </h2>
            <div className="space-y-2">
              {items.map((it) => (
                <IssueCard key={it.issueId} issue={it} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
