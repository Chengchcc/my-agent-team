"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { Wrench } from "lucide-react";
import { PanelCell, PanelRow, PanelTable } from "@/components/ops/kit";
import { EmptyState } from "@/components/ui/empty-state";
import type { TelemetrySummary } from "@/lib/api";
import { formatDurationMs } from "@/lib/duration";
import { t } from "@/lib/i18n";

function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return formatDurationMs(ms);
}

/** ADR 0085 D3: Tool performance (call volume, error rate, P50/P95 latency)
 *  and Skill activation breakdown. */
export function ToolsSkillsPanel({ telemetry }: { telemetry: UseQueryResult<TelemetrySummary> }) {
  if (telemetry.isPending) {
    return <p className="px-4 py-6 text-xs text-(--mute)">{t("Loading…")}</p>;
  }
  if (telemetry.isError) {
    return (
      <EmptyState
        icon={Wrench}
        title={t("Tool metrics are not available")}
        description={t("The backend did not answer the telemetry summary request.")}
      />
    );
  }
  const summary = telemetry.data;
  if (summary.toolStats.length === 0 && summary.skillStats.length === 0) {
    return (
      <EmptyState
        icon={Wrench}
        title={t("No tool or skill activity in this window")}
        description={t("Tool latency and skill activations appear here as runs execute.")}
      />
    );
  }

  return (
    <div className="space-y-4">
      {summary.toolStats.length > 0 && (
        <PanelTable
          label={t("Tool performance")}
          columns={[t("Tool"), t("Calls"), t("Errors"), t("Error rate"), t("P50"), t("P95")]}
        >
          {summary.toolStats.map((tool) => (
            <PanelRow key={tool.toolName}>
              <PanelCell label={t("Tool")} className="font-mono text-(--ink-strong)">
                {tool.toolName}
              </PanelCell>
              <PanelCell label={t("Calls")} className="font-mono tabular-nums">
                {tool.calls}
              </PanelCell>
              <PanelCell
                label={t("Errors")}
                className={`font-mono tabular-nums ${tool.errors > 0 ? "text-(--err)" : ""}`}
              >
                {tool.errors}
              </PanelCell>
              <PanelCell
                label={t("Error rate")}
                className={`font-mono tabular-nums ${tool.errorRate > 0.1 ? "text-(--err)" : ""}`}
              >
                {`${Math.round(tool.errorRate * 100)}%`}
              </PanelCell>
              <PanelCell label={t("P50")} className="font-mono tabular-nums">
                {fmtMs(tool.p50Ms)}
              </PanelCell>
              <PanelCell label={t("P95")} className="font-mono tabular-nums">
                {fmtMs(tool.p95Ms)}
              </PanelCell>
            </PanelRow>
          ))}
        </PanelTable>
      )}

      {summary.skillStats.length > 0 && (
        <PanelTable
          label={t("Skill activations")}
          columns={[t("Skill"), t("Activations"), t("Runs"), t("Success rate"), t("Avg active")]}
        >
          {summary.skillStats.map((sk) => (
            <PanelRow key={sk.skillName}>
              <PanelCell label={t("Skill")} className="font-mono text-(--ink-strong)">
                {sk.skillName}
              </PanelCell>
              <PanelCell label={t("Activations")} className="font-mono tabular-nums">
                {sk.activations}
              </PanelCell>
              <PanelCell label={t("Runs")} className="font-mono tabular-nums">
                {sk.runs}
              </PanelCell>
              <PanelCell label={t("Success rate")} className="font-mono tabular-nums">
                {sk.successRate === null ? "—" : `${Math.round(sk.successRate * 100)}%`}
              </PanelCell>
              <PanelCell label={t("Avg active")} className="font-mono tabular-nums">
                {fmtMs(sk.avgDurationMs)}
              </PanelCell>
            </PanelRow>
          ))}
        </PanelTable>
      )}
    </div>
  );
}
