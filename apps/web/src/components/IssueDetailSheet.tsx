"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import type { IssueEvent, IssueRow, IssueRunSummary, IssueStatus } from "@/lib/api";
import { api } from "@/lib/api";
import { IssueStatusBadge } from "./IssueStatusBadge";

const PRIORITY_COLORS: Record<string, string> = {
  P0: "bg-red-600 text-white hover:bg-red-700",
  P1: "bg-orange-500 text-white hover:bg-orange-600",
  P2: "bg-blue-500 text-white hover:bg-blue-600",
  P3: "bg-muted text-muted-foreground hover:bg-muted/80",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  planned: "计划中",
  in_progress: "开发中",
  in_review: "待 Review",
  done: "已完成",
};

// Legal transitions — mirrors backend LEGAL_TRANSITIONS
const LEGAL_TRANSITIONS: Record<string, IssueStatus[]> = {
  draft: ["planned"],
  planned: ["in_progress"],
  in_progress: ["in_review"],
  in_review: ["done"], // rework must go through Approve/Reject, not this button
  done: [],
};

function formatRelativeTime(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function eventLabel(kind: IssueEvent["kind"]): string {
  switch (kind) {
    case "created":
      return "Created";
    case "started":
      return "Started";
    case "run.started":
      return "Run started";
    case "run.ended":
      return "Run ended";
    case "deliverable.submitted":
      return "Deliverable";
    case "status.advanced":
      return "Advanced";
    case "human.decided":
      return "Human decided";
  }
}

function TimelineEntry({ event }: { event: IssueEvent }) {
  return (
    <div className="flex gap-2 text-xs py-1 border-b border-border/30">
      <span className="text-muted-foreground w-16 shrink-0">{formatRelativeTime(event.ts)}</span>
      <span className="font-medium w-36 shrink-0">{eventLabel(event.kind)}</span>
      <span className="text-muted-foreground truncate">{JSON.stringify(event.payload)}</span>
    </div>
  );
}

function RunEntry({ run }: { run: IssueRunSummary }) {
  return (
    <div className="flex items-center gap-2 text-xs py-1">
      <span className="text-muted-foreground w-20 shrink-0">{run.fromStatus} baton</span>
      <span className="w-12 shrink-0">{run.agentId}</span>
      <span
        className={`w-16 shrink-0 ${
          run.status === "succeeded"
            ? "text-green-600"
            : run.status === "failed"
              ? "text-red-600"
              : "text-yellow-600"
        }`}
      >
        {run.status}
      </span>
      <Link
        href={`/ops/runs/${run.runId}`}
        className="text-blue-600 hover:underline ml-auto"
        target="_blank"
      >
        View run &rarr;
      </Link>
    </div>
  );
}

export function IssueDetailSheet({
  issue,
  open,
  onClose,
}: {
  issue: IssueRow;
  open: boolean;
  onClose: () => void;
}) {
  const [timeline, setTimeline] = useState<IssueEvent[]>([]);
  const [runs, setRuns] = useState<IssueRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [editing, setEditing] = useState(false);

  const editForm = useForm({
    defaultValues: {
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      estimatedCompletionAt: issue.estimatedCompletionAt,
    },
  });

  async function handleSave(formData: {
    title: string;
    description: string;
    priority: typeof issue.priority;
    estimatedCompletionAt: number | null;
  }) {
    try {
      await api.updateIssue(issue.issueId, formData);
      toast.success("Issue updated");
      setEditing(false);
      onClose();
    } catch (err) {
      toast.error("Failed to save", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    let es: EventSource | null = null;
    let cancelled = false;

    api.getIssueDetail(issue.issueId).then((data) => {
      if (cancelled) return;
      setTimeline(data.timeline);
      setRuns(data.runs);
      setLoading(false);

      es = new EventSource(`/api/bff/issues/${issue.issueId}/timeline/events`);
      es.addEventListener("issue-event", (e) => {
        let event: IssueEvent;
        try {
          event = JSON.parse(e.data) as IssueEvent;
        } catch {
          return;
        }
        setTimeline((prev) => (prev.some((x) => x.seq === event.seq) ? prev : [...prev, event]));
      });
      es.onerror = () => {};
    });

    return () => {
      cancelled = true;
      es?.close();
    };
  }, [issue.issueId, open]);

  const legalNext = LEGAL_TRANSITIONS[issue.status] ?? [];

  async function handleTransition(to: IssueStatus) {
    setTransitioning(true);
    try {
      await api.applyTransition(issue.issueId, to);
      onClose();
    } catch (err) {
      toast.error("Failed to transition", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setTransitioning(false);
    }
  }

  async function handleDelete() {
    if (!confirm("确定删除此 Issue？")) return;
    setDeleting(true);
    try {
      await api.deleteIssue(issue.issueId);
      toast.success("Issue deleted");
      onClose();
    } catch (err) {
      toast.error("Failed to delete", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setDeleting(false);
    }
  }

  const succeeded = runs.filter((r) => r.status === "succeeded").length;
  const failed = runs.filter((r) => r.status === "failed").length;
  const running = runs.filter((r) => r.status === "running").length;

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <SheetContent side="right" className="w-[480px] sm:max-w-[540px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 truncate">
              {issue.title}
              <IssueStatusBadge status={issue.status} />
            </span>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                className="text-xs h-7"
                disabled={transitioning}
                onClick={() => {
                  editForm.reset({
                    title: issue.title,
                    description: issue.description,
                    priority: issue.priority,
                    estimatedCompletionAt: issue.estimatedCompletionAt,
                  });
                  setEditing(true);
                }}
              >
                编辑
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="text-xs h-7"
                disabled={deleting}
                onClick={handleDelete}
              >
                删除
              </Button>
            </div>
          </SheetTitle>
        </SheetHeader>

        {/* Edit form */}
        {editing && (
          <Form {...editForm}>
            <form
              onSubmit={editForm.handleSubmit(handleSave)}
              className="space-y-3 mb-4 p-3 border rounded"
            >
              <FormField
                control={editForm.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Title</FormLabel>
                    <FormControl>
                      <Input className="h-7 text-xs" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Description</FormLabel>
                    <FormControl>
                      <Textarea className="text-xs min-h-[60px]" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="priority"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Priority</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="h-7 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="P0">P0</SelectItem>
                        <SelectItem value="P1">P1</SelectItem>
                        <SelectItem value="P2">P2</SelectItem>
                        <SelectItem value="P3">P3</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
              <div className="flex gap-2">
                <Button size="sm" className="text-xs h-7" type="submit">
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs h-7"
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </Form>
        )}

        {/* Property table */}
        <div className="text-xs space-y-1.5 mb-4 mt-4">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground w-20 shrink-0">状态</span>
            <IssueStatusBadge status={issue.status} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground w-20 shrink-0">优先级</span>
            <Badge className={PRIORITY_COLORS[issue.priority] ?? ""}>{issue.priority}</Badge>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground w-20 shrink-0">创建时间</span>
            <span>{new Date(issue.createdAt).toLocaleString()}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground w-20 shrink-0">预计完成</span>
            <span>
              {issue.estimatedCompletionAt
                ? new Date(issue.estimatedCompletionAt).toLocaleDateString()
                : "未填写"}
            </span>
          </div>
          {issue.description && (
            <div className="flex gap-2">
              <span className="text-muted-foreground w-20 shrink-0">描述</span>
              <span className="whitespace-pre-wrap">{issue.description}</span>
            </div>
          )}
        </div>

        {/* Status advance buttons */}
        {legalNext.length > 0 && (
          <div className="flex gap-2 mb-4">
            {legalNext.map((toStatus) => (
              <Button
                key={toStatus}
                size="sm"
                variant="outline"
                className="text-xs"
                disabled={transitioning}
                onClick={() => handleTransition(toStatus)}
              >
                移动到 {STATUS_LABELS[toStatus] ?? toStatus}
              </Button>
            ))}
          </div>
        )}

        {/* Coding Thread card */}
        <div className="mb-4">
          <h3 className="text-sm font-medium mb-2">Coding Thread</h3>
          <Link
            href={`/conversations/${issue.issueId}`}
            className="block p-3 rounded border border-border hover:bg-muted/30 transition-colors"
          >
            <div className="text-sm font-medium">{issue.title}</div>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="outline" className="text-xs">
                CLAUDE_CODE
              </Badge>
              <span className="text-xs text-muted-foreground">Thread: {issue.issueId}</span>
            </div>
            <div className="text-xs text-blue-600 mt-1">查看 Coding &rarr;</div>
          </Link>
        </div>

        {/* Run summary */}
        <div className="mb-4 p-2 bg-muted/30 rounded text-xs">
          Runs: {succeeded} succeeded &middot; {failed} failed &middot; {running} running
          {runs.length === 0 && " (none yet)"}
        </div>
        {runs.length > 0 && (
          <div className="mb-4">
            <h3 className="text-sm font-medium mb-1">Runs</h3>
            {runs.map((r) => (
              <RunEntry key={r.runId} run={r} />
            ))}
          </div>
        )}

        {/* Timeline */}
        <div>
          <h3 className="text-sm font-medium mb-1">Timeline</h3>
          {loading ? (
            <div className="text-xs text-muted-foreground">Loading...</div>
          ) : timeline.length === 0 ? (
            <div className="text-xs text-muted-foreground">No events yet</div>
          ) : (
            timeline.map((e) => <TimelineEntry key={e.seq} event={e} />)
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
