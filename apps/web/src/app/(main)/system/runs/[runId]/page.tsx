"use client";

import { useParams } from "next/navigation";
import { RunInsightsPanel } from "@/components/ops/RunInsightsPanel";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
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
import { useOpsSessionDetail } from "@/features/ops/hooks";

export const dynamic = "force-dynamic";

export default function SystemRunDetailPage() {
  const { runId } = useParams<{ runId: string }>();

  const detailQuery = useOpsSessionDetail(runId);
  const detail = detailQuery.data;

  return (
    <div className="container mx-auto p-6 space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/system">System</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbItem>
            <BreadcrumbPage>Run {runId.slice(0, 12)}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {detailQuery.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {detailQuery.error && <p className="text-sm text-destructive">Failed to load run detail</p>}

      {detail && (
        <>
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold">Session Detail</h1>
            <Badge variant="outline" className="text-xs font-mono">
              {detail.sessionId.slice(0, 16)}
            </Badge>
            <Badge
              variant={detail.status === "running" ? "default" : "outline"}
              className="text-xs"
            >
              {detail.status}
            </Badge>
          </div>

          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableBody>
                  <TableRow>
                    <TableCell className="text-xs text-muted-foreground w-40">Agent</TableCell>
                    <TableCell className="text-xs">{detail.agentId}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="text-xs text-muted-foreground">Span Count</TableCell>
                    <TableCell className="text-xs">{detail.spanCount}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <h3 className="text-sm font-semibold mb-3">Spans</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Span ID</TableHead>
                    <TableHead className="text-xs">Kind</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                    <TableHead className="text-xs">Started</TableHead>
                    <TableHead className="text-xs">Ended</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.spans.map((sp) => (
                    <TableRow key={sp.spanId}>
                      <TableCell className="font-mono text-xs">{sp.spanId.slice(0, 16)}…</TableCell>
                      <TableCell className="text-xs">{sp.kind}</TableCell>
                      <TableCell className="text-xs">
                        <Badge variant="outline" className="text-xs">
                          {sp.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {sp.startedAt ? new Date(sp.startedAt).toLocaleString() : "-"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {sp.endedAt ? new Date(sp.endedAt).toLocaleString() : "-"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <RunInsightsPanel runId={runId} />
        </>
      )}
    </div>
  );
}
