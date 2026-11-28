"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { OpsWindow } from "@/features/ops/queries";
import type { TelemetrySummary } from "@/lib/api";
import { t } from "@/lib/i18n";
import { fmtTokens } from "./format";

const WINDOW_LABEL: Record<OpsWindow, string> = {
  "1h": "60 minutes ago",
  "24h": "24 hours ago",
  "7d": "7 days ago",
  "30d": "30 days ago",
};

/** Token use per hour in the chosen window, from the telemetry summary's own
 *  `costByHour` buckets. An empty window says so instead of drawing a flat line. */
export function TokenAreaChart({ data, range }: { data: TelemetrySummary; range: OpsWindow }) {
  const multiDay = range === "7d" || range === "30d";
  const rows = data.costByHour.map((bucket) => ({
    hour: multiDay
      ? new Date(bucket.hour).toLocaleDateString(undefined, { month: "numeric", day: "numeric" })
      : new Date(bucket.hour).toLocaleTimeString(undefined, { hour: "numeric" }),
    tokens: bucket.tokens,
    costUsd: bucket.costUsd,
  }));
  const tokens = data.inputTokens + data.outputTokens;

  return (
    <div className="rounded-[15px] border border-(--hairline) bg-[linear-gradient(160deg,#1b2b30,#172026)] p-[23px]">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[11px] tracking-[1px] uppercase text-(--primary)">
          {t("Token activity")} · {range}
        </span>
        <span className="font-mono text-[10px] text-(--mute)">
          {fmtTokens(tokens)} {t("tokens")} / {data.runs} {data.runs === 1 ? t("run") : t("runs")}
        </span>
      </div>
      <div className="h-[170px] w-full">
        {rows.length === 0 ? (
          <p className="pt-16 text-center text-xs text-(--mute)">{t("No usage in this window.")}</p>
        ) : (
          <ResponsiveContainer>
            <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="tokFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.16} />
                  <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--hairline)" strokeOpacity={0.6} />
              <XAxis
                dataKey="hour"
                tick={{ fontSize: 10, fill: "var(--mute)" }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                width={44}
                tick={{ fontSize: 10, fill: "var(--mute)" }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value: number) => fmtTokens(value)}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--canvas-soft)",
                  border: "1px solid var(--hairline)",
                  borderRadius: 8,
                  fontSize: 11,
                }}
              />
              <Area
                type="monotone"
                dataKey="tokens"
                stroke="var(--chart-1)"
                strokeWidth={2}
                fill="url(#tokFill)"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
      <div className="mt-2 flex justify-between font-mono text-[10px] text-(--mute)">
        <span>{t(WINDOW_LABEL[range])}</span>
        <span>{t("now")}</span>
      </div>
    </div>
  );
}
