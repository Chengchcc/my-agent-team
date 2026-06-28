"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { useOpsInsightsSummary } from "@/features/ops/hooks";
import { QueryState } from "./QueryState";

const ROW_H = 32;
const minH = 100;
const maxH = 600;
const chartH = (items: number) => Math.min(maxH, Math.max(minH, items * ROW_H + 40));

const chartConfig = {
  count: { label: "Invocations", color: "var(--chart-3)" },
} satisfies ChartConfig;

export function TopToolsChart({ range }: { range: { from: number; to: number } }) {
  const query = useOpsInsightsSummary(range, { refetchInterval: 30_000 });

  return (
    <QueryState query={query}>
      {(data) =>
        data.topTools.length === 0 ? (
          <div className="text-xs text-muted-foreground p-4 text-center min-h-[100px] flex items-center justify-center">
            No tool data in this window.
          </div>
        ) : (
          <ChartContainer
            config={chartConfig}
            className="w-full"
            style={{ height: chartH(data.topTools.length) }}
          >
            <BarChart
              accessibilityLayer
              data={data.topTools.map((t) => ({
                name: t.name,
                count: t.count,
                errorRate: Math.round(t.errorRate * 100),
              }))}
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
              layout="vertical"
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tickLine={false} axisLine={false} tickMargin={8} />
              <YAxis
                type="category"
                dataKey="name"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                width={120}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value, _name, item) => {
                      const payload = (item as { payload?: { errorRate?: number } } | undefined)
                        ?.payload;
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
