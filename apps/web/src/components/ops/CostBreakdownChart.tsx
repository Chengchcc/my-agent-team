"use client";

import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { QueryState } from "./QueryState";

const chartConfig = {
  costUsd: { label: "Cost (USD, est.)", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function CostBreakdownChart({ range }: { range: { from: number; to: number } }) {
  const query = useQuery({
    queryKey: ["ops", "insights", "summary", range],
    queryFn: () => api.getInsightsSummary(range),
    refetchInterval: 30_000,
  });

  return (
    <QueryState query={query}>
      {(data) =>
        data.costByModel.length === 0 && data.costByAgent.length === 0 ? (
          <div className="text-xs text-muted-foreground p-4 text-center">No cost data in this window.</div>
        ) : (
          <div className="space-y-6">
            {data.costByModel.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Cost by Model</h4>
                <ChartContainer config={chartConfig} className="min-h-[200px] w-full">
                  <BarChart
                    accessibilityLayer
                    data={data.costByModel.map((m) => ({ name: m.model, costUsd: m.costUsd ?? 0 }))}
                    margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                    layout="vertical"
                  >
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(v: number) => `$${v.toFixed(2)}`} />
                    <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} tickMargin={8} width={140} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="costUsd" fill="var(--color-costUsd)" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ChartContainer>
              </div>
            )}
            {data.costByAgent.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Cost by Agent</h4>
                <ChartContainer config={chartConfig} className="min-h-[200px] w-full">
                  <BarChart
                    accessibilityLayer
                    data={data.costByAgent.map((a) => ({ name: a.agentName, costUsd: a.costUsd ?? 0 }))}
                    margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                    layout="vertical"
                  >
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(v: number) => `$${v.toFixed(2)}`} />
                    <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} tickMargin={8} width={140} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="costUsd" fill="var(--color-costUsd)" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ChartContainer>
              </div>
            )}
            <p className="text-[10px] text-muted-foreground text-right">All costs are estimates based on current pricing.</p>
          </div>
        )
      }
    </QueryState>
  );
}
