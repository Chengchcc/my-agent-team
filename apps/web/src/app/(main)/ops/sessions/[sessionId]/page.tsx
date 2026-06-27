"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";

export const dynamic = "force-dynamic";

export default function SessionDetailPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ["ops", "sessionDetail", sessionId],
    queryFn: () => api.getOpsSessionDetail(sessionId),
    enabled: !!sessionId,
    refetchInterval: (q) =>
      q.state.data?.status === "running" ? 10_000 : false,
  });

  const detail = detailQuery.data;

  return (
    <div className="container mx-auto p-6 space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/ops">Observability</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink href="/ops/sessions">Sessions</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage className="font-mono">{sessionId}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {detailQuery.isLoading && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {detailQuery.isError && (
        <p className="text-sm text-destructive">Failed to load session.</p>
      )}
      {!detail && !detailQuery.isLoading && (
        <p className="text-sm text-muted-foreground">Session not found.</p>
      )}

      {detail && (
        <>
          {/* Session header */}
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
                          setSelectedSpanId(
                            selectedSpanId === span.spanId ? null : span.spanId,
                          )
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
          {selectedSpanId && (
            <RunInsightsPanel runId={selectedSpanId} />
          )}
        </>
      )}
    </div>
  );
}
