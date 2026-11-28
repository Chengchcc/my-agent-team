"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtTokens } from "@/components/ops/format";
import type { TelemetrySummary } from "@/lib/api";
import { formatDurationMs } from "@/lib/duration";
import { t } from "@/lib/i18n";

function KpiCard({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "default" | "warn" | "ok";
}) {
  const accent =
    tone === "warn" ? "text-(--warn)" : tone === "ok" ? "text-(--ok)" : "text-(--ink-strong)";
  return (
    <div className="rounded-[12px] border border-(--hairline) bg-(--panel) px-4 py-3">
      <div className="font-mono text-[10px] uppercase tracking-kicker text-(--faint)">{label}</div>
      <div className={`mt-1 font-mono text-lg font-semibold tabular-nums ${accent}`}>{value}</div>
      <div className="mt-0.5 truncate font-mono text-[10px] text-(--mute)">{sub}</div>
    </div>
  );
}

/** ADR 0085 D3: Performance & reliability insights — P50/P95 active latency,
 *  prompt cache hit rate, TTFT, 7d success/latency trend, failure causes,
 *  spinning run alerts, and behavioral quality signals. */
export function TelemetryInsights({ data }: { data: TelemetrySummary }) {
  const cacheRate = data.cacheHitRate !== null ? `${Math.round(data.cacheHitRate * 100)}%` : "—";
  const p50 = data.p50DurationMs !== null ? formatDurationMs(data.p50DurationMs) : "—";
  const p95 = data.p95DurationMs !== null ? formatDurationMs(data.p95DurationMs) : "—";
  const ttft =
    data.p50TtftMs !== null ? `${data.p50TtftMs}ms / ${data.p95TtftMs ?? data.p50TtftMs}ms` : "—";

  const trendRows = data.successRateByDay.map((day, idx) => {
    const dur = data.durationByDay[idx];
    return {
      day: new Date(day.dayStart).toLocaleDateString(undefined, {
        month: "numeric",
        day: "numeric",
      }),
      successPct: day.successRate !== null ? Math.round(day.successRate * 100) : 0,
      runs: day.runs,
      failed: day.failed,
      p95Sec: dur?.p95DurationMs != null ? Math.round(dur.p95DurationMs / 100) / 10 : 0,
    };
  });

  const qs = data.qualitySignals;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label={t("Active latency (P50 / P95)")}
          value={`${p50} / ${p95}`}
          sub={
            data.totalHumanWaitMs > 0
              ? t("{wait} human wait stripped", { wait: formatDurationMs(data.totalHumanWaitMs) })
              : t("Excludes human wait time")
          }
        />
        <KpiCard
          label={t("Prompt cache hit")}
          value={cacheRate}
          sub={t("{read} read · {write} write", {
            read: fmtTokens(data.cacheReadTokens),
            write: fmtTokens(data.cacheWriteTokens),
          })}
          tone={data.cacheHitRate !== null && data.cacheHitRate >= 0.5 ? "ok" : "default"}
        />
        <KpiCard
          label={t("TTFT (P50 / P95)")}
          value={ttft}
          sub={t("{calls} tool calls in window", { calls: data.toolCalls })}
        />
        <KpiCard
          label={t("Quality signals")}
          value={String(qs.total)}
          sub={t("unasked {u} · unrouted {r} · corrected {c}", {
            u: qs.unaskedQuestion + qs.irreversibleUnasked,
            r: qs.unroutedWork + qs.statusQuestionDispatched,
            c: qs.answerCorrected,
          })}
          tone={qs.total > 0 ? "warn" : "ok"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-[12px] border border-(--hairline) bg-(--panel) p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-kicker text-(--faint)">
              {t("7-day success rate (%)")}
            </span>
            <span className="font-mono text-[10px] text-(--mute)">
              {t("{days} active days", { days: trendRows.length })}
            </span>
          </div>
          <div className="h-[130px] w-full">
            {trendRows.length === 0 ? (
              <p className="pt-10 text-center text-xs text-(--mute)">{t("No trend data yet.")}</p>
            ) : (
              <ResponsiveContainer>
                <BarChart data={trendRows} margin={{ top: 6, right: 6, bottom: 0, left: -16 }}>
                  <CartesianGrid vertical={false} stroke="var(--hairline)" strokeOpacity={0.5} />
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 10, fill: "var(--mute)" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    domain={[0, 100]}
                    tick={{ fontSize: 10, fill: "var(--mute)" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--canvas-soft)",
                      border: "1px solid var(--hairline)",
                      borderRadius: 8,
                      fontSize: 11,
                    }}
                  />
                  <Bar dataKey="successPct" fill="var(--ok)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="rounded-[12px] border border-(--hairline) bg-(--panel) p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-kicker text-(--faint)">
              {t("Failure causes & anomalies")}
            </span>
            <span className="font-mono text-[10px] text-(--mute)">
              {t("{count} failures", { count: data.failures.length })}
            </span>
          </div>

          {data.failureCauses.length === 0 ? (
            <p className="text-xs text-(--mute)">{t("No failures recorded in this window.")}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {data.failureCauses.map((fc) => (
                <span
                  key={fc.cause}
                  className="inline-flex items-center gap-1.5 rounded-full border border-(--err)/30 bg-(--err)/10 px-2.5 py-1 font-mono text-[11px] text-(--err)"
                >
                  <span>{fc.cause}</span>
                  <span className="font-semibold tabular-nums">{fc.count}</span>
                </span>
              ))}
            </div>
          )}

          {data.spinningRuns.length > 0 && (
            <div className="rounded-[8px] border border-(--warn)/30 bg-(--warn)/10 p-2.5">
              <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-kicker text-(--warn)">
                <AlertTriangle className="size-3.5" />
                {t("Spinning runs detected ({count})", { count: data.spinningRuns.length })}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {data.spinningRuns.map((sr) => (
                  <Link
                    key={sr.runId}
                    href={`/system/runs/${sr.runId}`}
                    className="rounded border border-(--warn)/30 px-2 py-0.5 font-mono text-[10px] text-(--ink-strong) hover:border-(--warn)"
                  >
                    {sr.runId.slice(0, 10)} · {sr.toolCalls} calls
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
