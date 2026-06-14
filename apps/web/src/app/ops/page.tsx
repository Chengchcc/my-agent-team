"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { RunOpsTable } from "@/components/ops/RunOpsTable";
import { AgentRuntimeCard } from "@/components/ops/AgentRuntimeCard";

export default function OpsPage() {
  const { data: runs = [] } = useQuery({
    queryKey: ["ops", "runs"],
    queryFn: () => api.listOpsRuns({ limit: 50 }),
    staleTime: 10_000,
  });

  const { data: agents = [] } = useQuery({
    queryKey: ["agents"],
    queryFn: api.listAgents,
    staleTime: 30_000,
  });

  const { data: runtimes = [] } = useQuery({
    queryKey: ["ops", "agentRuntime", agents.slice(0, 10).map((a) => a.id)],
    queryFn: async () => {
      const results = await Promise.all(
        agents.slice(0, 10).map((a) => api.getAgentRuntime(a.id).catch(() => null)),
      );
      return results.filter(Boolean);
    },
    enabled: agents.length > 0,
    staleTime: 10_000,
  });

  return (
    <div className="container mx-auto p-6 space-y-8">
      <h1 className="text-2xl font-bold">Observability</h1>

      <section>
        <h2 className="text-lg font-semibold mb-3">Agent Runtimes</h2>
        {runtimes.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No agent runtime data available.
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {runtimes.map(
              (rt) =>
                rt && <AgentRuntimeCard key={rt.agentId} runtime={rt} />,
            )}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Recent Runs</h2>
        <div className="rounded-lg border">
          <RunOpsTable runs={runs} />
        </div>
      </section>
    </div>
  );
}
