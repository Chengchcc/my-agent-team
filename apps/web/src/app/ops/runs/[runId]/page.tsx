"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { RunOpsTimeline } from "@/components/ops/RunOpsTimeline";
import Link from "next/link";

const statusColor: Record<string, string> = {
  running: "bg-blue-100 text-blue-800",
  succeeded: "bg-green-100 text-green-800",
  error: "bg-red-100 text-red-800",
  aborted: "bg-gray-100 text-gray-600",
  interrupted: "bg-orange-100 text-orange-800",
};

export default function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();

  const { data: detail } = useQuery({
    queryKey: ["ops", "runDetail", runId],
    queryFn: () => api.getOpsRunDetail(runId),
    enabled: !!runId,
  });

  if (!detail) {
    return (
      <div className="container mx-auto p-6">
        <Link href="/ops" className="text-muted-foreground hover:text-foreground text-sm">
          ← Observability
        </Link>
        <p className="text-muted-foreground mt-4">Loading...</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/ops"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Observability
        </Link>
        <h1 className="text-xl font-bold font-mono">{runId}</h1>
        <span
          className={`inline-block rounded px-2 py-0.5 text-sm font-medium ${
            statusColor[detail.run.status] ?? "bg-gray-100 text-gray-600"
          }`}
        >
          {detail.run.status}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-lg border p-4">
          <h3 className="text-sm font-semibold mb-2">Run Info</h3>
          <div className="text-sm space-y-1">
            <div><span className="text-muted-foreground">Agent: </span>{detail.run.agentId}</div>
            <div><span className="text-muted-foreground">Kind: </span>{detail.run.kind}</div>
            <div><span className="text-muted-foreground">Thread: </span><span className="font-mono text-xs">{detail.run.threadId}</span></div>
            <div><span className="text-muted-foreground">Trace: </span>
              {detail.run.traceId ? (
                <Link href={`/ops/traces/${detail.run.traceId}`} className="font-mono text-xs text-primary hover:underline">
                  {detail.run.traceId.slice(0, 16)}...
                </Link>
              ) : "—"}
            </div>
            <div><span className="text-muted-foreground">Started: </span>{new Date(detail.run.startedAt).toISOString()}</div>
            {detail.run.endedAt && <div><span className="text-muted-foreground">Ended: </span>{new Date(detail.run.endedAt).toISOString()}</div>}
          </div>
        </div>

        <div className="rounded-lg border p-4">
          <h3 className="text-sm font-semibold mb-2">Attempts</h3>
          {detail.attempts.map((a) => (
            <div key={a.attemptId} className="text-xs font-mono space-y-0.5 mb-2">
              <div>ID: {a.attemptId.slice(0, 16)}...</div>
              <div>Heartbeat: {a.heartbeatAgeMs != null ? `${Math.floor(a.heartbeatAgeMs / 1000)}s ago` : "none"}</div>
              <div>Transport: {a.transport}</div>
            </div>
          ))}
        </div>

        <div className="rounded-lg border p-4">
          <h3 className="text-sm font-semibold mb-2">Event Log</h3>
          <div className="text-sm">
            <div><span className="text-muted-foreground">Last Seq: </span>{detail.eventLog.lastSeq ?? "—"}</div>
            <div><span className="text-muted-foreground">Last Event: </span>{detail.eventLog.lastEventType ?? "—"}</div>
          </div>
        </div>
      </div>

      <div className="rounded-lg border p-4">
        <h3 className="text-sm font-semibold mb-4">Ops Events</h3>
        <RunOpsTimeline ops={detail.ops} />
      </div>
    </div>
  );
}
