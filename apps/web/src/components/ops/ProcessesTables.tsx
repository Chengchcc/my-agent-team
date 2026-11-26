"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { Cpu, Radio } from "lucide-react";
import { fmtAgo, fmtBytes } from "@/components/ops/format";
import { Note, PanelCell, PanelRow, PanelTable, StatusBadge } from "@/components/ops/kit";
import { EmptyState } from "@/components/ui/empty-state";
import type { SurfaceRow, SystemMetricsRow } from "@/features/ops/ops-types";
import { surfaceConnection } from "@/features/ops/surface-state";
import { formatDurationMs } from "@/lib/duration";
import { t } from "@/lib/i18n";

const RUNNING = { label: "running", shape: "●", tone: "live" } as const;

interface ProcessRow {
  key: string;
  name: string;
  note: string;
  memoryBytes: number;
  cpuSec: number | null;
}

/** The backend's own process and the children it has spawned. The first row is
 *  there whenever the request answered; the children come from a /proc
 *  snapshot, so a child is listed only while it is alive. */
export function ProcessesTable({ metrics }: { metrics: UseQueryResult<SystemMetricsRow> }) {
  if (metrics.isPending) {
    return <p className="px-4 py-6 text-xs text-(--mute)">{t("Loading…")}</p>;
  }
  if (metrics.isError) {
    return (
      <EmptyState
        icon={Cpu}
        title={t("Process metrics are not available")}
        description={t("The backend did not answer the system-metrics request.")}
      />
    );
  }
  const data = metrics.data;
  const rows: ProcessRow[] = [
    {
      key: "backend",
      name: "backend",
      note: `${t("uptime")} ${formatDurationMs(data.uptimeSec * 1000)} · ${t("heap")} ${fmtBytes(data.heapMb * 1024 * 1024)}`,
      memoryBytes: data.rssMb * 1024 * 1024,
      cpuSec: null,
    },
  ];
  for (const child of data.subprocesses) {
    rows.push({
      key: String(child.pid),
      name: child.cmd.split(" ")[0] ?? "child",
      note: `pid ${child.pid} · ${child.cmd}`,
      memoryBytes: (child.rssKb ?? 0) * 1024,
      cpuSec: child.cpuSec,
    });
  }

  return (
    <div className="space-y-3">
      <PanelTable
        label={t("Processes")}
        columns={[t("Process"), t("State"), t("Memory"), t("CPU time")]}
      >
        {rows.map((row) => (
          <PanelRow key={row.key}>
            <PanelCell label={t("Process")}>
              <span className="font-mono text-(--ink-strong)">{row.name}</span>
              <small className="mt-0.5 block font-mono text-[10px] text-(--mute)">{row.note}</small>
            </PanelCell>
            <PanelCell label={t("State")}>
              <StatusBadge look={RUNNING} />
            </PanelCell>
            <PanelCell label={t("Memory")} className="font-mono tabular-nums">
              {fmtBytes(row.memoryBytes)}
            </PanelCell>
            <PanelCell label={t("CPU time")} className="font-mono tabular-nums">
              {row.cpuSec === null ? "—" : `${row.cpuSec}s`}
            </PanelCell>
          </PanelRow>
        ))}
      </PanelTable>
      <Note>
        {data.subprocesses.length === 0
          ? t("No child process: nothing is running under the backend right now.")
          : t("Children are a snapshot of the backend's process table at the last request.")}
      </Note>
    </div>
  );
}

/** Every surface that ever sent a heartbeat, and whether it still does. A row
 *  whose last beat is older than three missed beats reads as disconnected:
 *  the status it posted then is history, not the present. */
export function SurfacesTable({
  surfaces,
  agentName,
  now,
}: {
  surfaces: UseQueryResult<SurfaceRow[]>;
  agentName: (agentId: string) => string;
  now: number;
}) {
  if (surfaces.isPending) {
    return <p className="px-4 py-6 text-xs text-(--mute)">{t("Loading…")}</p>;
  }
  if (surfaces.isError) {
    return (
      <EmptyState
        icon={Radio}
        title={t("Surface health is not available")}
        description={t("The backend did not answer the surfaces request.")}
      />
    );
  }
  if (surfaces.data.length === 0) {
    return (
      <EmptyState
        icon={Radio}
        title={t("No surface is reporting")}
        description={t("A Lark bot appears here after it sends its first heartbeat.")}
      />
    );
  }
  return (
    <PanelTable
      label={t("Surfaces")}
      columns={[t("Surface"), t("Connection"), t("Last seen"), t("Last error")]}
    >
      {surfaces.data.map((surface) => (
        <PanelRow key={`${surface.agentId}-${surface.surface}`}>
          <PanelCell label={t("Surface")}>
            <span className="text-(--ink-strong)">{agentName(surface.agentId)}</span>
            <small className="mt-0.5 block font-mono text-[10px] text-(--mute)">
              {surface.surface}
            </small>
          </PanelCell>
          <PanelCell label={t("Connection")}>
            <StatusBadge look={surfaceConnection(surface.status, surface.lastSeenAt, now)} />
          </PanelCell>
          <PanelCell label={t("Last seen")} className="font-mono">
            {surface.lastSeenAt === null
              ? t("never")
              : t("{ago} ago", { ago: fmtAgo(surface.lastSeenAt, now) })}
          </PanelCell>
          <PanelCell label={t("Last error")}>
            {surface.lastError === null ? (
              <span className="text-(--faint)">—</span>
            ) : (
              <span className="font-mono text-(--err) wrap-anywhere">{surface.lastError}</span>
            )}
          </PanelCell>
        </PanelRow>
      ))}
    </PanelTable>
  );
}
