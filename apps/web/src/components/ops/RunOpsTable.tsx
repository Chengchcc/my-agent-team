"use client";

import Link from "next/link";
import type { RunOpsListItem } from "@/lib/api";
import { diagnoseRunListItem } from "@/lib/ops-diagnosis";

function statusBadge(status: string): string {
  switch (status) {
    case "running":     return "bg-blue-950 text-blue-400";
    case "succeeded":   return "bg-green-950 text-green-400";
    case "error":       return "bg-red-950 text-red-400";
    case "interrupted": return "bg-amber-950 text-amber-400";
    default:            return "bg-muted text-muted-foreground";
  }
}

const diagnosisLabel: Record<string, string> = {
  running: "Healthy",
  heartbeat_stale: "Stale",
  detached_waiting_reaper: "Detached",
  surface_projection_failed: "Surface fail",
  terminal: "Terminal",
};

const transportLabel: Record<string, string> = {
  attached: "Attached",
  noop: "Detached placeholder",
  detached: "Detached",
};

function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export function RunOpsTable({ runs, heartbeatTimeoutMs = 60_000 }: { runs: RunOpsListItem[]; heartbeatTimeoutMs?: number }) {
  // Sort: needs_attention first (detached, stale, running), then terminal
  const sorted = [...runs].sort((a, b) => {
    const scoreA = a.status === "running" ? (a.runnerTransport === "attached" ? 1 : 0) : 2;
    const scoreB = b.status === "running" ? (b.runnerTransport === "attached" ? 1 : 0) : 2;
    return scoreA - scoreB;
  });

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-2 pr-3 font-medium text-xs">Diagnosis</th>
            <th className="py-2 pr-3 font-medium text-xs">Run ID</th>
            <th className="py-2 pr-3 font-medium text-xs">Agent</th>
            <th className="py-2 pr-3 font-medium text-xs">Status</th>
            <th className="py-2 pr-3 font-medium text-xs">Runner connection</th>
            <th className="py-2 pr-3 font-medium text-xs">Heartbeat</th>
            <th className="py-2 pr-3 font-medium text-xs">Last event</th>
            <th className="py-2 pr-3 font-medium text-xs">Started</th>
            <th className="py-2 font-medium text-xs" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const d = diagnoseRunListItem(r, heartbeatTimeoutMs);
            return (
              <tr key={r.runId} className="border-b hover:bg-muted transition-colors">
                <td className="py-2 pr-3">
                  <span className="text-xs text-muted-foreground">
                    {diagnosisLabel[d.kind] ?? d.kind}
                  </span>
                </td>
                <td className="py-2 pr-3 font-mono text-xs text-foreground">
                  {r.runId.slice(0, 12)}…
                </td>
                <td className="py-2 pr-3 text-foreground">{r.agentId}</td>
                <td className="py-2 pr-3">
                  <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${statusBadge(r.status)}`}>
                    {r.status}
                  </span>
                </td>
                <td className="py-2 pr-3 text-xs text-foreground">
                  {transportLabel[r.runnerTransport] ?? r.runnerTransport}
                </td>
                <td className="py-2 pr-3 text-xs text-foreground">
                  {r.heartbeatAgeMs != null
                    ? `${Math.floor(r.heartbeatAgeMs / 1000)}s`
                    : "—"}
                </td>
                <td className="py-2 pr-3 text-xs text-foreground">
                  {r.lastOpsEventKind ?? r.lastEventType ?? "—"}
                </td>
                <td className="py-2 pr-3 text-xs text-muted-foreground">{ago(r.startedAt)} ago</td>
                <td className="py-2">
                  <Link
                    href={`/ops/runs/${r.runId}`}
                    className="text-primary text-xs hover:underline"
                  >
                    Detail
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
