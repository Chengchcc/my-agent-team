"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IssueStatusBadge } from "./IssueStatusBadge";
import type { IssueEvent, IssueRow, IssueRunSummary } from "@/lib/api";
import { api } from "@/lib/api";

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
      <span className="text-muted-foreground w-16 shrink-0">
        {formatRelativeTime(event.ts)}
      </span>
      <span className="font-medium w-36 shrink-0">
        {eventLabel(event.kind)}
      </span>
      <span className="text-muted-foreground truncate">
        {JSON.stringify(event.payload)}
      </span>
    </div>
  );
}

function RunEntry({ run }: { run: IssueRunSummary }) {
  return (
    <div className="flex items-center gap-2 text-xs py-1">
      <span className="text-muted-foreground w-20 shrink-0">
        {run.fromStatus} baton
      </span>
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

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    let es: EventSource | undefined;

    api.getIssueDetail(issue.issueId).then((data) => {
      setTimeline(data.timeline);
      setRuns(data.runs);
      setLoading(false);
    });

    // SSE for live timeline updates
    es = new EventSource(
      `/api/bff/issues/${issue.issueId}/timeline/events`,
    );
    es.addEventListener("issue-event", (e) => {
      const event = JSON.parse(e.data) as IssueEvent;
      setTimeline((prev) => [...prev, event]);
    });
    es.onerror = () => {
      // SSE connection lost — data already in timeline from getIssueDetail
    };

    return () => {
      es?.close();
    };
  }, [issue.issueId, open]);

  const succeeded = runs.filter((r) => r.status === "succeeded").length;
  const failed = runs.filter((r) => r.status === "failed").length;
  const running = runs.filter((r) => r.status === "running").length;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {issue.title}
            <IssueStatusBadge status={issue.status} />
          </DialogTitle>
        </DialogHeader>

        {/* Section 1: Meta */}
        <div className="text-xs text-muted-foreground space-y-1 mb-4">
          <div>Project: {issue.projectId}</div>
          <div>Thread: {issue.threadId}</div>
          <div>
            Created: {new Date(issue.createdAt).toLocaleString()}
          </div>
        </div>

        {/* Section 2: Run summary */}
        <div className="mb-4 p-2 bg-muted/30 rounded text-xs">
          Runs: {succeeded} succeeded &middot; {failed} failed &middot;{" "}
          {running} running
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

        {/* Section 3: Timeline */}
        <div>
          <h3 className="text-sm font-medium mb-1">Timeline</h3>
          {loading ? (
            <div className="text-xs text-muted-foreground">Loading...</div>
          ) : timeline.length === 0 ? (
            <div className="text-xs text-muted-foreground">
              No events yet
            </div>
          ) : (
            timeline.map((e) => <TimelineEntry key={e.seq} event={e} />)
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
