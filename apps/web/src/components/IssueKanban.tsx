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
import { issueKeys } from "@/features/issues/hooks";
import type { IssueRow, IssueStatus } from "@/lib/api";
import { api } from "@/lib/api";
import { COLUMN_LABEL } from "@/lib/issue-labels";
import { IssueCard } from "./IssueCard";
import { IssueDetailSheet } from "./IssueDetailSheet";

function DraggableIssueCard({
  issue,
  onDecision,
  onOpenDetail,
}: {
  issue: IssueRow;
  onDecision?: () => void;
  onOpenDetail?: () => void;
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
      <IssueCard issue={issue} onDecision={onDecision} onOpenDetail={onOpenDetail} />
    </div>
  );
}

function DroppableColumn({
  status,
  items,
  onDecision,
  onOpenDetail,
}: {
  status: IssueStatus | "unknown";
  items: IssueRow[];
  onDecision?: () => void;
  onOpenDetail?: (issueId: string) => void;
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
          <DraggableIssueCard
            key={it.issueId}
            issue={it}
            onDecision={onDecision}
            onOpenDetail={() => onOpenDetail?.(it.issueId)}
          />
        ))}
      </div>
    </section>
  );
}

export function IssueKanban({ statuses, issues }: { statuses: readonly IssueStatus[]; issues: IssueRow[] }) {
  const queryClient = useQueryClient();
  const [activeIssue, setActiveIssue] = useState<IssueRow | null>(null);
  const [openIssueId, setOpenIssueId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  // M19: hide the draft column by default — the board only shows planned+.
  // Fix (Problem 3): but if draft issues actually exist, surface a proper
  // "草稿" column instead of dumping them into the generic "Other" bucket.
  const hasDraft = issues.some((i) => i.status === "draft");
  const boardStatuses = statuses.filter((s) => s !== "draft" || hasDraft);

  // Fix 6: use boardStatuses for empty check — avoids blank kanban when only draft exists
  if (boardStatuses.length === 0) {
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
  const byStatus = new Map<IssueStatus, IssueRow[]>(boardStatuses.map((s) => [s, []]));
  const unmatched: IssueRow[] = [];
  for (const it of issues) {
    const bucket = byStatus.get(it.status);
    if (bucket) bucket.push(it);
    else unmatched.push(it);
  }

  // 未知状态的 Issue 不被静默丢弃 — 收进兜底列显式提示
  const columns: readonly (IssueStatus | "unknown")[] =
    unmatched.length > 0 ? [...boardStatuses, "unknown"] : boardStatuses;

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

    // Block drops onto the draft column: there is no *→draft transition. The
    // draft column only renders so existing draft issues are visible — it is
    // not a valid move target, so reject the drag instead of firing a
    // guaranteed-to-fail applyTransition + error toast + rollback.
    if (toStatus === "draft") return;

    // Block reverse drag: rework must go through review-decision (approve/reject buttons)
    if (issue.status === "in_review" && toStatus === "in_progress") {
      toast.error("Review required", {
        description: "Use Approve/Reject buttons instead of dragging back",
      });
      return;
    }

    // Optimistic update: move locally first
    const prevStatus = issue.status;
    queryClient.setQueryData<{ issues: IssueRow[] }>(issueKeys.lists(), (old) => {
      if (!old) return old;
      return {
        issues: old.issues.map((i) =>
          i.issueId === issueId ? { ...i, status: toStatus as IssueStatus } : i,
        ),
      };
    });

    try {
      await api.applyTransition(issueId, toStatus as IssueStatus);
      queryClient.invalidateQueries({ queryKey: issueKeys.lists() });
    } catch (err) {
      // Rollback on failure
      queryClient.setQueryData<{ issues: IssueRow[] }>(issueKeys.lists(), (old) => {
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
    queryClient.invalidateQueries({ queryKey: issueKeys.lists() });
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex gap-4 p-6 overflow-x-auto">
        {columns.map((s) => {
          const items = s === "unknown" ? unmatched : (byStatus.get(s) ?? []);
          return (
            <DroppableColumn
              key={s}
              status={s}
              items={items}
              onDecision={handleDecision}
              onOpenDetail={setOpenIssueId}
            />
          );
        })}
      </div>

      <DragOverlay>
        {activeIssue ? <IssueCard issue={activeIssue} onDecision={handleDecision} /> : null}
      </DragOverlay>

      {(() => {
        const openIssue = openIssueId ? issues.find((i) => i.issueId === openIssueId) : undefined;
        // Guard: the issue may leave the list while the sheet is open (live
        // refetch, approve→done filtered out, drag to a hidden column). Render
        // nothing rather than passing undefined into the sheet and crashing.
        if (!openIssue) return null;
        return (
          <IssueDetailSheet issue={openIssue} open={true} onClose={() => setOpenIssueId(null)} />
        );
      })()}
    </DndContext>
  );
}
