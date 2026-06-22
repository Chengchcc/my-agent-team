"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { QueryState } from "@/components/ops/QueryState";
import { TraceWaterfall } from "@/components/ops/TraceWaterfall";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { api } from "@/lib/api";

export default function TraceDetailPage() {
  const { traceId } = useParams<{ traceId: string }>();

  const traceQuery = useQuery({
    queryKey: ["ops", "traceDetail", traceId],
    queryFn: () => api.getTraceOpsDetail(traceId),
    enabled: !!traceId,
  });

  return (
    <div className="container mx-auto p-6 space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/ops">Observability</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/ops/traces">Trace Explorer</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage className="font-mono">{traceId}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold font-mono text-foreground">{traceId}</h1>
      </div>

      <QueryState query={traceQuery}>
        {(detail) => (
          <div className="rounded-lg border p-4">
            <h2 className="text-lg font-semibold text-foreground mb-4">Trace Waterfall</h2>
            <TraceWaterfall detail={detail} />
          </div>
        )}
      </QueryState>
    </div>
  );
}
