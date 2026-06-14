"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { RunOpsTable } from "@/components/ops/RunOpsTable";
import { OpsTabs } from "@/components/ops/OpsTabs";
import Link from "next/link";

export default function RunsPage() {
  const { data: runs = [] } = useQuery({
    queryKey: ["ops", "runs"],
    queryFn: () => api.listOpsRuns({ limit: 100 }),
    staleTime: 10_000,
  });

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/ops" className="text-muted-foreground hover:text-foreground text-sm">← Observability</Link>
        <h1 className="text-2xl font-bold">Runs</h1>
      </div>

      <OpsTabs />

      <div className="rounded-lg border">
        <RunOpsTable runs={runs} />
      </div>
    </div>
  );
}
