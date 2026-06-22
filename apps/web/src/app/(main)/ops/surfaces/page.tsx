"use client";

import { useQuery } from "@tanstack/react-query";
import { QueryState } from "@/components/ops/QueryState";
import { SurfaceHealthPanel } from "@/components/ops/SurfaceHealthPanel";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { api } from "@/lib/api";

export default function SurfacesPage() {
  const surfacesQuery = useQuery({
    queryKey: ["ops", "surfaces"],
    queryFn: api.listSurfaces,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });

  return (
    <div className="container mx-auto p-6 space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/ops">Observability</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Surface Diagnostics</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <QueryState query={surfacesQuery} empty={(data) => data.length === 0}>
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
