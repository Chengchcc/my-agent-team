"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { CostBreakdownChart } from "@/components/ops/CostBreakdownChart";
import { HealthSummary } from "@/components/ops/HealthSummary";
import { NeedsAttentionList } from "@/components/ops/NeedsAttentionList";
import { QueryState } from "@/components/ops/QueryState";
import { RunOpsTable } from "@/components/ops/RunOpsTable";
import { TokenTrendChart } from "@/components/ops/TokenTrendChart";
import { TopToolsChart } from "@/components/ops/TopToolsChart";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";

const WINDOWS: Record<string, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
};

export default function OpsPage() {
  const [windowKey, setWindowKey] = useState("24h");

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
  const rangeMs = WINDOWS[windowKey] ?? WINDOWS["24h"]!;
  const chartRange = useMemo(() => {
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    return { from: now - rangeMs, to: now };
  }, [rangeMs]);

  const overviewQuery = {
    isLoading: runsQuery.isLoading || agentsQuery.isLoading || runtimesQuery.isLoading,
    isError: runsQuery.isError || agentsQuery.isError || runtimesQuery.isError,
    error: runsQuery.error ?? agentsQuery.error ?? runtimesQuery.error,
    data: { runs, runtimes } as const,
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage>Observability</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

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
              />
            </section>

            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  Run Insights
                </h2>
                <Select value={windowKey} onValueChange={(v) => v && setWindowKey(v)}>
                  <SelectTrigger className="w-[100px] h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1h">Last hour</SelectItem>
                    <SelectItem value="24h">Last 24h</SelectItem>
                    <SelectItem value="7d">Last 7 days</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="rounded-lg border p-4">
                  <h3 className="text-sm font-semibold text-foreground mb-3">Token Trends</h3>
                  <TokenTrendChart range={chartRange} />
                </div>
                <div className="rounded-lg border p-4">
                  <h3 className="text-sm font-semibold text-foreground mb-3">Cost Breakdown</h3>
                  <CostBreakdownChart range={chartRange} />
                </div>
                <div className="rounded-lg border p-4 lg:col-span-2">
                  <h3 className="text-sm font-semibold text-foreground mb-3">Top Tools</h3>
                  <TopToolsChart range={chartRange} />
                </div>
              </div>
            </section>

            <section>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Needs Attention
              </h2>
              <NeedsAttentionList
                runs={data.runs}
                runtimes={data.runtimes}
              />
            </section>

            <section>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Recent Activity
              </h2>
              <div className="rounded-lg border">
              </div>
            </section>
          </>
        )}
      </QueryState>
    </div>
  );
}
