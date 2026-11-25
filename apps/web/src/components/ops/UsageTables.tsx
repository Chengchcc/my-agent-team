"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { fmtTokens } from "@/components/ops/format";
import { PanelCell, PanelRow, PanelTable } from "@/components/ops/kit";
import { EmptyState } from "@/components/ui/empty-state";
import type { TelemetrySummary } from "@/lib/api";
import { t } from "@/lib/i18n";

/** Usage in the chosen window, as the telemetry summary aggregates it: per
 *  model, then per member. A window with no run says so; it does not show a
 *  table of zeros. */
export function UsageTables({
  telemetry,
  agentName,
  range,
}: {
  telemetry: UseQueryResult<TelemetrySummary>;
  agentName: (agentId: string) => string;
  range: "1h" | "24h";
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
    <div className="space-y-3">
      <PanelTable
        label={t("Usage by model")}
        columns={[t("Model"), t("Runs"), t("Failed"), t("Tokens"), t("Cost")]}
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
            <PanelCell label={t("Cost")} className="font-mono tabular-nums">
              ${row.costUsd.toFixed(4)}
            </PanelCell>
          </PanelRow>
        ))}
      </PanelTable>

      <PanelTable
        label={t("Usage by member")}
        columns={[t("Member"), t("Runs"), t("Failed"), t("Success rate")]}
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
              {row.successRate === null ? "—" : `${Math.round(row.successRate * 100)}%`}
            </PanelCell>
          </PanelRow>
        ))}
      </PanelTable>
    </div>
  );
}
