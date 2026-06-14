"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { AgentRuntimeCard } from "@/components/ops/AgentRuntimeCard";
import { RunOpsTable } from "@/components/ops/RunOpsTable";
import { OpsTabs } from "@/components/ops/OpsTabs";
import { QueryState } from "@/components/ops/QueryState";
import Link from "next/link";

export default function AgentRuntimePage() {
  const { agentId } = useParams<{ agentId: string }>();

  const runtimeQuery = useQuery({
    queryKey: ["ops", "agentRuntime", agentId],
    queryFn: () => api.getAgentRuntime(agentId),
    enabled: !!agentId,
  });

  const runsQuery = useQuery({
    queryKey: ["ops", "runs", agentId],
    queryFn: () => api.listOpsRuns({ agentId, limit: 20 }),
    enabled: !!agentId,
  });

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/ops" className="text-muted-foreground hover:text-foreground text-sm transition-colors">
          ← Observability
        </Link>
        <h1 className="text-2xl font-bold text-foreground">{agentId} — Runtime</h1>
      </div>

      <OpsTabs />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-1">
          <QueryState query={runtimeQuery}>
            {(runtime) => <AgentRuntimeCard runtime={runtime} />}
          </QueryState>
        </div>
        <div className="md:col-span-2">
          <section>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Recent Runs</h2>
            <div className="rounded-lg border">
              <QueryState query={runsQuery}>
                {(runs) => <RunOpsTable runs={runs} heartbeatTimeoutMs={runtimeQuery.data?.heartbeatTimeoutMs} />}
              </QueryState>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
