"use client";

import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { QueryState } from "./QueryState";

const chartConfig = {
  count: { label: "Invocations", color: "var(--chart-3)" },
} satisfies ChartConfig;

export function TopToolsChart({ range }: { range: { from: number; to: number } }) {
  const query = useQuery({
    queryKey: ["ops", "insights", "summary", range],
    queryFn: () => api.getInsightsSummary(range),
    refetchInterval: 30_000,
  });

  return (
    <QueryState query={query}>
      {(data) =>
        data.topTools.length === 0 ? (
          <div className="text-xs text-muted-foreground p-4 text-center">No tool data in this window.</div>
        ) : (
          <ChartContainer config={chartConfig} className="min-h-[200px] w-full">
            <BarChart
              accessibilityLayer
              data={data.topTools.map((t) => ({ name: t.name, count: t.count, errorRate: Math.round(t.errorRate * 100) }))}
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
              layout="vertical"
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tickLine={false} axisLine={false} tickMargin={8} />
              <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} tickMargin={8} width={120} />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value, _name, item) => {
                      const payload = (item as { payload?: { errorRate?: number } } | undefined)?.payload;
                      const rate = payload?.errorRate;
                      return (
                        <span>
                          {value as number} calls{rate != null ? ` (${rate}% errors)` : ""}
                        </span>
                      );
                    }}
                  />
                }
              />
              <Bar dataKey="count" fill="var(--color-count)" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ChartContainer>
        )
      }
    </QueryState>
  );
}
