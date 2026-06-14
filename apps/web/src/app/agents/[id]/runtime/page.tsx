"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { AgentRuntimeCard } from "@/components/ops/AgentRuntimeCard";
import { RunOpsTable } from "@/components/ops/RunOpsTable";
import Link from "next/link";

export default function AgentRuntimePage() {
  const { id: agentId } = useParams<{ id: string }>();

  const { data: runtime } = useQuery({
    queryKey: ["ops", "agentRuntime", agentId],
    queryFn: () => api.getAgentRuntime(agentId),
    enabled: !!agentId,
  });

  const { data: runs = [] } = useQuery({
    queryKey: ["ops", "runs", agentId],
    queryFn: () => api.listOpsRuns({ agentId, limit: 20 }),
    enabled: !!agentId,
  });

  if (!runtime) {
    return (
      <div className="container mx-auto p-6">
        <Link href="/ops" className="text-muted-foreground hover:text-foreground text-sm">← Dashboard</Link>
        <p className="text-muted-foreground mt-4">Loading...</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-8">
      <div className="flex items-center gap-3">
        <Link href="/ops" className="text-muted-foreground hover:text-foreground text-sm">← Dashboard</Link>
        <h1 className="text-2xl font-bold">{agentId} — Runtime</h1>
      </div>
      <div className="max-w-md">
        <AgentRuntimeCard runtime={runtime} />
      </div>
      <section>
        <h2 className="text-lg font-semibold mb-3">Recent Runs</h2>
        <div className="rounded-lg border">
          <RunOpsTable runs={runs} />
        </div>
      </section>
    </div>
  );
}
