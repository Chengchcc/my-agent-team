"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { RunInsightsPanel } from "@/components/ops/RunInsightsPanel";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLoopDetail } from "@/features/loop/hooks";
import { useOpsRunInsights, useOpsSessionDetail } from "@/features/ops/hooks";

export const dynamic = "force-dynamic";

function formatCost(usd: number | null | undefined): string {
  if (usd == null) return "—";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatToken(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms >= 60_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function RunDetailPage() {
  const { runId, loopId } = useParams<{ runId: string; loopId: string }>();
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);

  const loopQuery = useLoopDetail(loopId);
  const detailQuery = useOpsSessionDetail(runId);
  const insightsQuery = useOpsRunInsights(runId);

  const loopName = loopQuery.data?.loop?.name ?? loopId;
  const detail = detailQuery.data;
  const insights = insightsQuery.data;

  return (
    <div className="container mx-auto p-6 space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/work">Work</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink href={`/work/${loopId}`}>{loopName}</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink href={`/work/${loopId}`}>Runs</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage className="font-mono">{runId}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {detailQuery.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {detailQuery.isError && <p className="text-sm text-destructive">Failed to load run.</p>}
      {!detail && !detailQuery.isLoading && (
        <p className="text-sm text-muted-foreground">Run not found.</p>
      )}

      {detail && (
        <>
          {/* Run header */}
          <div className="rounded-lg border p-4 space-y-2">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold font-mono">{detail.sessionId}</h2>
              <Badge variant={detail.status === "running" ? "default" : "secondary"}>
                {detail.status}
              </Badge>
            </div>
            <div className="text-sm text-muted-foreground space-x-4">
              <span>Agent: {detail.agentId}</span>
              <span>Spans: {detail.spanCount}</span>
            </div>
          </div>

          {/* Run Insights — numeric cards + tool breakdown */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground">Run Insights</h3>

            {insightsQuery.isLoading && (
              <p className="text-sm text-muted-foreground animate-pulse">Loading insights…</p>
            )}
            {insightsQuery.isError && (
              <p className="text-sm text-destructive">Failed to load run insights.</p>
            )}

            {insights && insights.calls.length === 0 && (
              <p className="text-sm text-muted-foreground">
                This run has no collected metrics (pre-M16.3 data).
              </p>
            )}

            {insights && insights.calls.length > 0 && (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Card size="sm">
                    <CardContent className="space-y-1">
                      <p className="text-xs text-muted-foreground">Total Cost</p>
                      <p className="text-lg font-semibold">{formatCost(insights.root.totalCostUsd)}</p>
                    </CardContent>
                  </Card>
                  <Card size="sm">
                    <CardContent className="space-y-1">
                      <p className="text-xs text-muted-foreground">Input Tokens</p>
                      <p className="text-lg font-semibold">{formatToken(insights.root.totalInput)}</p>
                    </CardContent>
                  </Card>
                  <Card size="sm">
                    <CardContent className="space-y-1">
                      <p className="text-xs text-muted-foreground">Output Tokens</p>
                      <p className="text-lg font-semibold">{formatToken(insights.root.totalOutput)}</p>
                    </CardContent>
                  </Card>
                  <Card size="sm">
                    <CardContent className="space-y-1">
                      <p className="text-xs text-muted-foreground">Tool Calls</p>
                      <p className="text-lg font-semibold">{insights.root.toolCalls}</p>
                    </CardContent>
                  </Card>
                </div>

                {insights.toolBreakdown.length > 0 && (
                  <div className="rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Tool</TableHead>
                          <TableHead className="text-right">Calls</TableHead>
                          <TableHead className="text-right">Errors</TableHead>
                          <TableHead className="text-right">Avg Duration</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {insights.toolBreakdown.map((t) => (
                          <TableRow key={t.name}>
                            <TableCell className="font-mono text-xs">{t.name}</TableCell>
                            <TableCell className="text-right">{t.count}</TableCell>
                            <TableCell className="text-right">
                              {t.errorCount > 0 ? (
                                <span className="text-destructive">{t.errorCount}</span>
                              ) : (
                                "0"
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatDuration(t.count > 0 ? t.totalLatencyMs / t.count : null)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Span list */}
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Span ID</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Started</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.spans.map((span) => (
                  <TableRow
                    key={span.spanId}
                    className={selectedSpanId === span.spanId ? "bg-muted" : ""}
                  >
                    <TableCell>
                      <button
                        onClick={() =>
                          setSelectedSpanId(selectedSpanId === span.spanId ? null : span.spanId)
                        }
                        className="font-mono text-primary hover:underline text-left"
                      >
                        {span.spanId}
                      </button>
                    </TableCell>
                    <TableCell>{span.kind}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          span.status === "running"
                            ? "default"
                            : span.status === "error"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {span.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {span.startedAt ? new Date(span.startedAt).toLocaleString() : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Selected span insights */}
          {selectedSpanId && <RunInsightsPanel runId={selectedSpanId} />}
        </>
      )}
    </div>
  );
}
