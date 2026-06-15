"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { RunOpsListItem } from "@/lib/api";
import { diagnoseRunListItem } from "@/lib/ops-diagnosis";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const PAGE_SIZE = 20;

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
  const [page, setPage] = useState(0);

  // Sort: needs_attention first (detached, stale, running), then terminal
  const sorted = [...runs].sort((a, b) => {
    const scoreA = a.status === "running" ? (a.runnerTransport === "attached" ? 1 : 0) : 2;
    const scoreB = b.status === "running" ? (b.runnerTransport === "attached" ? 1 : 0) : 2;
    return scoreA - scoreB;
  });

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const paged = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs">Diagnosis</TableHead>
            <TableHead className="text-xs">Run ID</TableHead>
            <TableHead className="text-xs">Agent</TableHead>
            <TableHead className="text-xs">Status</TableHead>
            <TableHead className="text-xs">Connection</TableHead>
            <TableHead className="text-xs">Heartbeat</TableHead>
            <TableHead className="text-xs">Last event</TableHead>
            <TableHead className="text-xs">Started</TableHead>
            <TableHead className="text-xs w-0" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {paged.map((r) => {
            const d = diagnoseRunListItem(r, heartbeatTimeoutMs);
            return (
              <TableRow key={r.runId}>
                <TableCell>
                  <span className="text-xs text-muted-foreground">
                    {diagnosisLabel[d.kind] ?? d.kind}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-xs text-foreground">
                  {r.runId.slice(0, 12)}…
                </TableCell>
                <TableCell className="text-foreground" title={r.agentId}>{r.agentName}</TableCell>
                <TableCell>
                  <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${statusBadge(r.status)}`}>
                    {r.status}
                  </span>
                </TableCell>
                <TableCell className="text-xs text-foreground">
                  {transportLabel[r.runnerTransport] ?? r.runnerTransport}
                </TableCell>
                <TableCell className="text-xs text-foreground">
                  {r.heartbeatAgeMs != null
                    ? `${Math.floor(r.heartbeatAgeMs / 1000)}s`
                    : "—"}
                </TableCell>
                <TableCell className="text-xs text-foreground">
                  {r.lastOpsEventKind ?? r.lastEventType ?? "—"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{ago(r.startedAt)} ago</TableCell>
                <TableCell>
                  <Link
                    href={`/ops/runs/${r.runId}`}
                    className="text-primary text-xs hover:underline"
                  >
                    Detail
                  </Link>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-2 py-2 border-t">
          <span className="text-xs text-muted-foreground">
            {sorted.length} runs · page {page + 1} of {totalPages}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-default transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-default transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
