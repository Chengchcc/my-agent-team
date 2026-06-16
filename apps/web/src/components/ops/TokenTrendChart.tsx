"use client";

import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { api } from "@/lib/api";
import { QueryState } from "./QueryState";

const chartConfig = {
  input: { label: "Input tokens", color: "var(--chart-1)" },
  output: { label: "Output tokens", color: "var(--chart-2)" },
} satisfies ChartConfig;

export function TokenTrendChart({ range }: { range: { from: number; to: number } }) {
  const query = useQuery({
    queryKey: ["ops", "insights", "summary", range],
    queryFn: () => api.getInsightsSummary(range),
    refetchInterval: 30_000,
  });

  return (
    <QueryState query={query}>
      {(data) =>
        data.tokenSeries.length === 0 ? (
          <div className="text-xs text-muted-foreground p-4 text-center">
            No token data in this window.
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="h-[220px] w-full">
            <AreaChart
              accessibilityLayer
              data={data.tokenSeries}
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="ts"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(ts: number) => {
                  const d = new Date(ts);
                  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
                }}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Area
                type="monotone"
                dataKey="input"
                stroke="var(--color-input)"
                fill="var(--color-input)"
                fillOpacity={0.1}
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="output"
                stroke="var(--color-output)"
                fill="var(--color-output)"
                fillOpacity={0.1}
                strokeWidth={2}
              />
            </AreaChart>
          </ChartContainer>
        )
      }
    </QueryState>
  );
}
