"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { QueryState } from "@/components/ops/QueryState";
import { HealthSummary } from "@/components/ops/HealthSummary";
import { NeedsAttentionList } from "@/components/ops/NeedsAttentionList";
import { RunOpsTable } from "@/components/ops/RunOpsTable";
import { TokenTrendChart } from "@/components/ops/TokenTrendChart";
import { CostBreakdownChart } from "@/components/ops/CostBreakdownChart";
import { TopToolsChart } from "@/components/ops/TopToolsChart";

export default function OpsPage() {
  const runsQuery = useQuery({
    queryKey: ["ops", "runs"],
    queryFn: () => api.listOpsRuns({ limit: 100 }),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: api.listAgents,
    staleTime: 30_000,
  });

  const agents = agentsQuery.data ?? [];

  const runtimesQuery = useQuery({
    queryKey: ["ops", "agentRuntime", agents.map((a) => a.id)],
    queryFn: async () => {
      const results = await Promise.all(
        agents.map((a) => api.getAgentRuntime(a.id).catch(() => null)),
      );
      return results.filter((r): r is NonNullable<typeof r> => r != null);
    },
    enabled: agents.length > 0,
    staleTime: 10_000,
  });

  const runs = runsQuery.data ?? [];
  const runtimes = runtimesQuery.data ?? [];
  const heartbeatTimeoutMs = runtimes[0]?.heartbeatTimeoutMs ?? 60_000;

  const overviewQuery = {
    isLoading: runsQuery.isLoading || agentsQuery.isLoading || runtimesQuery.isLoading,
    isError: runsQuery.isError || agentsQuery.isError || runtimesQuery.isError,
    error: runsQuery.error ?? agentsQuery.error ?? runtimesQuery.error,
    data: { runs, runtimes, heartbeatTimeoutMs } as const,
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Observability</h1>


      <QueryState query={overviewQuery}>
        {(data) => (
          <>
            <section>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Health
              </h2>
              <HealthSummary
                runs={data.runs}
                runtimes={data.runtimes}
                heartbeatTimeoutMs={data.heartbeatTimeoutMs}
              />
            </section>

            <section>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Needs Attention
              </h2>
              <NeedsAttentionList
                runs={data.runs}
                runtimes={data.runtimes}
                heartbeatTimeoutMs={data.heartbeatTimeoutMs}
              />
            </section>

            <section>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Recent Activity
              </h2>
              <div className="rounded-lg border">
                <RunOpsTable runs={data.runs.slice(0, 20)} heartbeatTimeoutMs={data.heartbeatTimeoutMs} />
              </div>
            </section>

            <section>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Run Insights
              </h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="rounded-lg border p-4">
                  <h3 className="text-sm font-semibold text-foreground mb-3">Token Trends (24h)</h3>
                  <TokenTrendChart
                    range={{
                      from: Date.now() - 86_400_000,
                      to: Date.now(),
                    }}
                  />
                </div>
                <div className="rounded-lg border p-4">
                  <h3 className="text-sm font-semibold text-foreground mb-3">Cost Breakdown (24h)</h3>
                  <CostBreakdownChart
                    range={{
                      from: Date.now() - 86_400_000,
                      to: Date.now(),
                    }}
                  />
                </div>
                <div className="rounded-lg border p-4 lg:col-span-2">
                  <h3 className="text-sm font-semibold text-foreground mb-3">Top Tools (24h)</h3>
                  <TopToolsChart
                    range={{
                      from: Date.now() - 86_400_000,
                      to: Date.now(),
                    }}
                  />
                </div>
              </div>
            </section>
          </>
        )}
      </QueryState>
    </div>
  );
}
