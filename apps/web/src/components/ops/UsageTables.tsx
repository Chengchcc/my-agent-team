"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { fmtTokens } from "@/components/ops/format";
import { PanelCell, PanelRow, PanelTable } from "@/components/ops/kit";
import { EmptyState } from "@/components/ui/empty-state";
import type { OpsWindow } from "@/features/ops/queries";
import type { TelemetrySummary } from "@/lib/api";
import { formatDurationMs } from "@/lib/duration";
import { t } from "@/lib/i18n";

function fmtPct(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

/** Usage in the chosen window, as the telemetry summary aggregates it: per
 *  model (with cache hit rate & P95 latency), then per member. */
export function UsageTables({
  telemetry,
  agentName,
  range,
}: {
  telemetry: UseQueryResult<TelemetrySummary>;
  agentName: (agentId: string) => string;
  range: OpsWindow;
}) {
  if (telemetry.isPending) {
    return <p className="px-4 py-6 text-xs text-(--mute)">{t("Loading…")}</p>;
  }
  if (telemetry.isError) {
    return (
      <EmptyState
        icon={Gauge}
        title={t("Usage is not available")}
        description={t("The backend did not answer the telemetry summary request.")}
      />
    );
  }
  const summary = telemetry.data;
  if (summary.runs === 0) {
    return (
      <EmptyState
        icon={Gauge}
        title={t("No usage in this window")}
        description={t("No run started in the last {range}.", { range })}
      />
    );
  }
  return (
    <div className="space-y-4">
      <PanelTable
        label={t("Usage by model")}
        columns={[
          t("Model"),
          t("Runs"),
          t("Failed"),
          t("Tokens"),
          t("Cache hit"),
          t("P95 latency"),
          t("Cost"),
        ]}
      >
        {summary.byModel.map((row) => (
          <PanelRow key={row.modelId}>
            <PanelCell label={t("Model")} className="font-mono text-(--ink-strong)">
              {row.modelId}
            </PanelCell>
            <PanelCell label={t("Runs")} className="tabular-nums">
              {row.runs}
            </PanelCell>
            <PanelCell label={t("Failed")} className="tabular-nums">
              {row.failed}
            </PanelCell>
            <PanelCell label={t("Tokens")} className="font-mono tabular-nums">
              {fmtTokens(row.tokens)}
            </PanelCell>
            <PanelCell label={t("Cache hit")} className="font-mono tabular-nums">
              {fmtPct(row.cacheHitRate)}
            </PanelCell>
            <PanelCell label={t("P95 latency")} className="font-mono tabular-nums">
              {row.p95DurationMs !== null ? formatDurationMs(row.p95DurationMs) : "—"}
            </PanelCell>
            <PanelCell label={t("Cost")} className="font-mono tabular-nums">
              ${row.costUsd.toFixed(4)}
            </PanelCell>
          </PanelRow>
        ))}
      </PanelTable>

      <PanelTable
        label={t("Usage by member")}
        columns={[
          t("Member"),
          t("Runs"),
          t("Failed"),
          t("Success rate"),
          t("Cache hit"),
          t("Avg active"),
          t("Cost"),
        ]}
      >
        {summary.byAgent.map((row) => (
          <PanelRow key={row.agentId}>
            <PanelCell label={t("Member")} className="text-(--ink-strong)">
              {agentName(row.agentId)}
            </PanelCell>
            <PanelCell label={t("Runs")} className="tabular-nums">
              {row.runs}
            </PanelCell>
            <PanelCell label={t("Failed")} className="tabular-nums">
              {row.failed}
            </PanelCell>
            <PanelCell label={t("Success rate")} className="tabular-nums">
              {fmtPct(row.successRate)}
            </PanelCell>
            <PanelCell label={t("Cache hit")} className="font-mono tabular-nums">
              {fmtPct(row.cacheHitRate)}
            </PanelCell>
            <PanelCell label={t("Avg active")} className="font-mono tabular-nums">
              {row.avgDurationMs !== null ? formatDurationMs(row.avgDurationMs) : "—"}
            </PanelCell>
            <PanelCell label={t("Cost")} className="font-mono tabular-nums">
              ${row.costUsd.toFixed(4)}
            </PanelCell>
          </PanelRow>
        ))}
      </PanelTable>
    </div>
  );
}
