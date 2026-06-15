"use client";

import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { QueryState } from "./QueryState";

const CHART_CONFIG = {
  input: { label: "Input tokens", color: "var(--color-blue-500, #3b82f6)" },
  output: { label: "Output tokens", color: "var(--color-emerald-500, #10b981)" },
};

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
          <div className="text-xs text-muted-foreground p-4 text-center">No token data in this window.</div>
        ) : (
          <ChartContainer config={CHART_CONFIG} className="aspect-[21/9] max-h-[300px] w-full">
            <AreaChart data={data.tokenSeries} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="ts"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={(ts: number) => {
                  const d = new Date(ts);
                  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
                }}
              />
              <YAxis tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Area type="monotone" dataKey="input" stroke="var(--color-blue-500, #3b82f6)" fill="var(--color-blue-500, #3b82f6)" fillOpacity={0.1} strokeWidth={2} />
              <Area type="monotone" dataKey="output" stroke="var(--color-emerald-500, #10b981)" fill="var(--color-emerald-500, #10b981)" fillOpacity={0.1} strokeWidth={2} />
            </AreaChart>
          </ChartContainer>
        )
      }
    </QueryState>
  );
}
