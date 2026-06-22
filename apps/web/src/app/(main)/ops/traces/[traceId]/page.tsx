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
            <BreadcrumbLink href="/ops">Observability
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink href="/ops/traces">Trace Explorer
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage className="font-mono">{traceId}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

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
