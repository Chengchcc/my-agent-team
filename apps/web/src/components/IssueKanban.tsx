"use client";

import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import type { IssueRow, IssueStatus } from "@/lib/api";
import { api } from "@/lib/api";
import { IssueCard } from "./IssueCard";

const COLUMN_LABEL: Record<IssueStatus, string> = {
  draft: "草稿",
  planned: "计划中",
  in_progress: "开发中",
  in_review: "待 Review",
  done: "已完成",
};

function DraggableIssueCard({
  issue,
  onDecision,
}: {
  issue: IssueRow;
  onDecision?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: issue.issueId,
    data: { status: issue.status },
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.3 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes}>
      <IssueCard issue={issue} onDecision={onDecision} />
    </div>
  );
}

function DroppableColumn({
  status,
  items,
  onDecision,
}: {
  status: IssueStatus | "unknown";
  items: IssueRow[];
  onDecision?: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const label = status === "unknown" ? "Other" : (COLUMN_LABEL[status] ?? status);
  return (
    <section
      ref={setNodeRef}
      className={`w-72 shrink-0 rounded-lg transition-colors ${isOver ? "bg-[var(--canvas-soft)]" : ""}`}
    >
      <h2 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
        {label} ({items.length})
      </h2>
      <div className="space-y-2 min-h-[4rem]">
        {items.map((it) => (
          <DraggableIssueCard key={it.issueId} issue={it} onDecision={onDecision} />
        ))}
      </div>
    </section>
  );
}

export function IssueKanban({ statuses, issues }: { statuses: IssueStatus[]; issues: IssueRow[] }) {
  const queryClient = useQueryClient();
  const [activeIssue, setActiveIssue] = useState<IssueRow | null>(null);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

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

  function handleDragStart(event: DragStartEvent) {
    const issueId = event.active.id as string;
    const issue = issues.find((i) => i.issueId === issueId);
    if (issue) setActiveIssue(issue);
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveIssue(null);
    const { active, over } = event;
    if (!over) return;

    const issueId = active.id as string;
    const toStatus = over.id as string;
    const issue = issues.find((i) => i.issueId === issueId);
    if (!issue || issue.status === toStatus) return;

    // Optimistic update: move locally first
    const prevStatus = issue.status;
    queryClient.setQueryData<{ issues: IssueRow[] }>(["issues"], (old) => {
      if (!old) return old;
      return {
        issues: old.issues.map((i) =>
          i.issueId === issueId ? { ...i, status: toStatus as IssueStatus } : i,
        ),
      };
    });

    try {
      await api.applyTransition(issueId, toStatus as IssueStatus);
      queryClient.invalidateQueries({ queryKey: ["issues"] });
    } catch (err) {
      // Rollback on failure
      queryClient.setQueryData<{ issues: IssueRow[] }>(["issues"], (old) => {
        if (!old) return old;
        return {
          issues: old.issues.map((i) => (i.issueId === issueId ? { ...i, status: prevStatus } : i)),
        };
      });
      const msg = err instanceof Error ? err.message : "Failed to move issue";
      toast.error("无法移动", { description: msg });
    }
  }

  function handleDecision() {
    queryClient.invalidateQueries({ queryKey: ["issues"] });
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex gap-4 p-6 overflow-x-auto">
        {columns.map((s) => {
          const items = s === "unknown" ? unmatched : (byStatus.get(s) ?? []);
          return <DroppableColumn key={s} status={s} items={items} onDecision={handleDecision} />;
        })}
      </div>

      <DragOverlay>
        {activeIssue ? <IssueCard issue={activeIssue} onDecision={handleDecision} /> : null}
      </DragOverlay>
    </DndContext>
  );
}
