"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ExecutionPath } from "@/components/ops/ExecutionPath";
import { QueryState } from "@/components/ops/QueryState";
import { RunControlStrip } from "@/components/ops/RunControlStrip";
import { RunDiagnosisHeader } from "@/components/ops/RunDiagnosisHeader";
import { RunInsightsPanel } from "@/components/ops/RunInsightsPanel";
import { RunOpsTimeline } from "@/components/ops/RunOpsTimeline";
import { api } from "@/lib/api";

export default function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();

  const detailQuery = useQuery({
    queryKey: ["ops", "runDetail", runId],
    queryFn: () => api.getOpsRunDetail(runId),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data?.run.status === "running" ? 10_000 : false),
  });

  const runtimeQuery = useQuery({
    queryKey: ["ops", "agentRuntime", detailQuery.data?.run.agentId],
    queryFn: () => api.getAgentRuntime(detailQuery.data!.run.agentId),
    enabled: !!detailQuery.data?.run.agentId,
  });

  const heartbeatTimeoutMs = runtimeQuery.data?.heartbeatTimeoutMs ?? 60_000;

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/ops"
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          ← Observability
        </Link>
        <h1 className="text-xl font-bold font-mono text-foreground">{runId}</h1>
        {detailQuery.dataUpdatedAt > 0 && (
          <span className="text-[10px] text-muted-foreground">
            updated {Math.floor((Date.now() - detailQuery.dataUpdatedAt) / 1000)}s ago
          </span>
        )}
      </div>

      <QueryState query={detailQuery}>
        {(detail) => (
          <>
            <RunDiagnosisHeader detail={detail} heartbeatTimeoutMs={heartbeatTimeoutMs} />
            <RunControlStrip detail={detail} heartbeatTimeoutMs={heartbeatTimeoutMs} />

            <RunInsightsPanel runId={runId} />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-6">
                <div className="rounded-lg border p-4">
                  <h3 className="text-sm font-semibold text-foreground mb-3">Where it is stuck</h3>
                  <div className="text-sm space-y-1">
                    <div>
                      <span className="text-muted-foreground">Runner connection: </span>
                      <span className="text-foreground">
                        {detail.attempts[0]?.transport ?? "unknown"}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Heartbeat: </span>
                      <span className="text-foreground">
                        {detail.attempts[0]?.heartbeatAgeMs != null
                          ? `${Math.floor(detail.attempts[0].heartbeatAgeMs / 1000)}s ago`
                          : "none"}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Last event: </span>
                      <span className="text-foreground">
                        {detail.eventLog.lastEventType ?? "—"}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Last diagnostic: </span>
                      <span className="text-foreground">{detail.ops.at(-1)?.kind ?? "—"}</span>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border p-4">
                  <h3 className="text-sm font-semibold text-foreground mb-3">Execution path</h3>
                  <ExecutionPath detail={detail} />
                </div>
              </div>

              <div className="space-y-6">
                <div className="rounded-lg border p-4">
                  <h3 className="text-sm font-semibold text-foreground mb-3">Attempts</h3>
                  <div className="space-y-2">
                    {detail.attempts.map((a) => (
                      <div key={a.attemptId} className="text-xs font-mono space-y-0.5">
                        <div className="text-muted-foreground">ID: {a.attemptId.slice(0, 16)}…</div>
                        <div className="text-foreground">
                          Heartbeat:{" "}
                          {a.heartbeatAgeMs != null
                            ? `${Math.floor(a.heartbeatAgeMs / 1000)}s ago`
                            : "none"}
                        </div>
                        <div className="text-foreground">Runner connection: {a.transport}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-lg border p-4">
                  <h3 className="text-sm font-semibold text-foreground mb-3">Event Log</h3>
                  <div className="text-sm space-y-1">
                    <div>
                      <span className="text-muted-foreground">Last Seq: </span>
                      <span className="text-foreground">{detail.eventLog.lastSeq ?? "—"}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Last Event: </span>
                      <span className="text-foreground">
                        {detail.eventLog.lastEventType ?? "—"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-lg border p-4">
              <h3 className="text-sm font-semibold text-foreground mb-4">Diagnostic timeline</h3>
              <RunOpsTimeline ops={detail.ops} />
            </div>
          </>
        )}
      </QueryState>
    </div>
  );
}
