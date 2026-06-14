"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import Link from "next/link";

export default function TracesPage() {
  const { data: runs = [] } = useQuery({
    queryKey: ["ops", "runs"],
    queryFn: () => api.listOpsRuns({ limit: 100 }),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/ops" className="text-muted-foreground hover:text-foreground text-sm transition-colors">
          ← Observability
        </Link>
        <h1 className="text-2xl font-bold text-foreground">Trace Explorer</h1>
      </div>


      <div className="rounded-lg border p-4">
        <p className="text-muted-foreground text-sm mb-4">
          Showing runs with trace IDs from run_origin. Full trace waterfall
          requires OTLP backend (set MIRA_OBSERVABILITY_MODE=otlp).
        </p>
        <div className="space-y-2">
          {runs.filter((r) => r.traceId).length === 0 ? (
            <p className="text-muted-foreground text-sm">No traces recorded yet.</p>
          ) : (
            runs.filter((r) => r.traceId).map((r) => (
              <div key={r.runId} className="flex items-center gap-4 text-sm">
                <span className="font-mono text-foreground">{r.traceId!.slice(0, 16)}…</span>
                <span className="text-foreground">{r.status}</span>
                <Link href={`/ops/runs/${r.runId}`} className="text-primary hover:underline">View Run</Link>
                <Link href={`/ops/traces/${r.traceId}`} className="text-primary hover:underline text-xs">Trace View</Link>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
