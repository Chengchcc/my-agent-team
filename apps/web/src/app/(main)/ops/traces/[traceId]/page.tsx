"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { OpsTabs } from "@/components/ops/OpsTabs";
import { QueryState } from "@/components/ops/QueryState";
import { TraceWaterfall } from "@/components/ops/TraceWaterfall";
import Link from "next/link";

export default function TraceDetailPage() {
  const { traceId } = useParams<{ traceId: string }>();

  const traceQuery = useQuery({
    queryKey: ["ops", "traceDetail", traceId],
    queryFn: () => api.getTraceOpsDetail(traceId),
    enabled: !!traceId,
  });

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/ops/traces" className="text-muted-foreground hover:text-foreground text-sm transition-colors">
          ← Traces
        </Link>
        <h1 className="text-xl font-bold font-mono text-foreground">{traceId}</h1>
      </div>

      <OpsTabs />

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
