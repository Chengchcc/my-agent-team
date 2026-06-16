"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

export default function TracesPage() {
  const [search, setSearch] = useState("");

  const { data: runs = [] } = useQuery({
    queryKey: ["ops", "runs"],
    queryFn: () => api.listOpsRuns({ limit: 100 }),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  // Dedup by traceId, collect run statuses
  const traces = useMemo(() => {
    const map = new Map<string, { runs: typeof runs; statuses: Set<string> }>();
    for (const r of runs) {
      if (!r.traceId) continue;
      const entry = map.get(r.traceId) ?? { runs: [], statuses: new Set<string>() };
      entry.runs.push(r);
      entry.statuses.add(r.status);
      map.set(r.traceId, entry);
    }
    return Array.from(map.entries())
      .filter(([traceId]) => !search || traceId.includes(search))
      .map(([traceId, entry]) => ({
        traceId,
        runs: entry.runs,
        statuses: Array.from(entry.statuses),
      }));
  }, [runs, search]);

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/ops"
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
        >
          ← Observability
        </Link>
        <h1 className="text-2xl font-bold text-foreground">Trace Explorer</h1>
      </div>

      <Input
        placeholder="Search by trace ID (recent 100 runs)…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-sm"
      />

      <div className="rounded-lg border">
        {traces.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {search
              ? "No traces match your search within the most recent 100 runs."
              : "No traces recorded yet."}
          </p>
        ) : (
          <div className="divide-y divide-border">
            {traces.map((t) => (
              <div key={t.traceId} className="flex items-center gap-4 p-3 text-sm">
                <span
                  className="font-mono text-foreground w-[180px] shrink-0 truncate"
                  title={t.traceId}
                >
                  {t.traceId}
                </span>
                <span className="text-muted-foreground text-xs">{t.statuses.join(", ")}</span>
                <span className="text-muted-foreground text-xs">
                  {t.runs.length} run{t.runs.length !== 1 ? "s" : ""}
                </span>
                <Link
                  href={`/ops/traces/${t.traceId}`}
                  className="text-primary hover:underline text-xs ml-auto"
                >
                  Trace View
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
