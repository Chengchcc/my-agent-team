"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AgentRuntimeCard } from "@/components/ops/AgentRuntimeCard";
import { QueryState } from "@/components/ops/QueryState";
import { RunOpsTable } from "@/components/ops/RunOpsTable";
import { api } from "@/lib/api";

export default function AgentRuntimePage() {
  const { agentId } = useParams<{ agentId: string }>();

  const runtimeQuery = useQuery({
    queryKey: ["ops", "agentRuntime", agentId],
    queryFn: () => api.getAgentRuntime(agentId),
    enabled: !!agentId,
    refetchInterval: 10_000,
  });

  const runsQuery = useQuery({
    queryKey: ["ops", "runs", agentId],
    queryFn: () => api.listOpsRuns({ agentId, limit: 20 }),
    enabled: !!agentId,
    refetchInterval: 10_000,
  });

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/ops"
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          ← Observability
        </Link>
        <h1 className="text-2xl font-bold text-foreground">
          {runtimeQuery.data?.agentName ?? agentId} — Runtime
        </h1>
        <div className="text-xs text-muted-foreground font-mono">{agentId}</div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-1">
          <QueryState query={runtimeQuery}>
            {(runtime) => <AgentRuntimeCard runtime={runtime} />}
          </QueryState>
        </div>
        <div className="md:col-span-2">
          <section>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              Recent Runs
            </h2>
            <div className="rounded-lg border">
              <QueryState query={runsQuery}>
                {(runs) => (
                  <RunOpsTable
                    runs={runs}
                    heartbeatTimeoutMs={runtimeQuery.data?.heartbeatTimeoutMs}
                  />
                )}
              </QueryState>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
