"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { OpsTabs } from "@/components/ops/OpsTabs";
import { QueryState } from "@/components/ops/QueryState";
import { SurfaceHealthPanel } from "@/components/ops/SurfaceHealthPanel";
import Link from "next/link";

export default function SurfacesPage() {
  const surfacesQuery = useQuery({
    queryKey: ["ops", "surfaces"],
    queryFn: api.listSurfaces,
    staleTime: 10_000,
  });

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/ops" className="text-muted-foreground hover:text-foreground text-sm transition-colors">
          ← Observability
        </Link>
        <h1 className="text-2xl font-bold text-foreground">Surface Diagnostics</h1>
      </div>

      <OpsTabs />

      <QueryState
        query={surfacesQuery}
        empty={(data) => data.length === 0}
      >
        {(surfaces) => (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {surfaces.map((s) => (
              <SurfaceHealthPanel key={`${s.agentId}-${s.surface}`} surface={s} />
            ))}
          </div>
        )}
      </QueryState>
    </div>
  );
}
