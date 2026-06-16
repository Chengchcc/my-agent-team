"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RunOpsListItem } from "@/lib/api";
import { diagnoseRunListItem } from "@/lib/ops-diagnosis";

const PAGE_SIZE = 20;

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "running":
      return "default";
    case "succeeded":
      return "secondary";
    case "error":
      return "destructive";
    case "interrupted":
      return "outline";
    default:
      return "secondary";
  }
}

const diagnosisLabel: Record<string, string> = {
  running: "Healthy",
  heartbeat_stale: "Stale",
  detached_waiting_reaper: "Detached",
  surface_projection_failed: "Surface fail",
  terminal: "Terminal",
};

const diagnosisColor: Record<string, string> = {
  running: "text-primary",
  heartbeat_stale: "text-[var(--chart-4)]",
  detached_waiting_reaper: "text-[var(--chart-3)]",
  surface_projection_failed: "text-destructive",
  terminal: "text-muted-foreground",
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

export function RunOpsTable({
  runs,
  heartbeatTimeoutMs = 60_000,
}: {
  runs: RunOpsListItem[];
  heartbeatTimeoutMs?: number;
}) {
  const [page, setPage] = useState(0);
  const prevRunCount = useRef(runs.length);
  useEffect(() => {
    if (runs.length !== prevRunCount.current) {
      setPage(0);
      prevRunCount.current = runs.length;
    }
  }, [runs.length]);

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
                  <span
                    className={`text-xs font-medium ${diagnosisColor[d.kind] ?? "text-muted-foreground"}`}
                  >
                    {diagnosisLabel[d.kind] ?? d.kind}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-xs text-foreground">
                  {r.runId.slice(0, 12)}…
                </TableCell>
                <TableCell
                  className="text-foreground text-xs max-w-[160px] truncate"
                  title={r.agentId}
                >
                  {r.agentName}
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(r.status)} className="text-xs">
                    {r.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-foreground">
                  {transportLabel[r.runnerTransport] ?? r.runnerTransport}
                </TableCell>
                <TableCell className="text-xs text-foreground">
                  {r.heartbeatAgeMs != null ? `${Math.floor(r.heartbeatAgeMs / 1000)}s` : "—"}
                </TableCell>
                <TableCell className="text-xs text-foreground">
                  {r.lastOpsEventKind ?? r.lastEventType ?? "—"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {ago(r.startedAt)} ago
                </TableCell>
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
        <div className="flex items-center justify-between py-2">
          <span className="text-xs text-muted-foreground">
            {sorted.length} runs · page {page + 1} of {totalPages}
          </span>
          <Pagination className="w-auto mx-0">
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  text="Previous"
                  onClick={() => setPage((p) => p - 1)}
                  className={page === 0 ? "pointer-events-none opacity-50" : "cursor-pointer"}
                />
              </PaginationItem>
              <PaginationItem>
                <PaginationNext
                  text="Next"
                  onClick={() => setPage((p) => p + 1)}
                  className={
                    page >= totalPages - 1 ? "pointer-events-none opacity-50" : "cursor-pointer"
                  }
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      )}
    </div>
  );
}
