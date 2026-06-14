"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { AgentRuntimeCard } from "@/components/ops/AgentRuntimeCard";
import { OpsTabs } from "@/components/ops/OpsTabs";
import Link from "next/link";

export default function AgentsPage() {
  const { data: agents = [] } = useQuery({
    queryKey: ["agents"],
    queryFn: api.listAgents,
    staleTime: 30_000,
  });

  const { data: runtimes = [] } = useQuery({
    queryKey: ["ops", "agentRuntime", agents.map((a) => a.id)],
    queryFn: async () => {
      const results = await Promise.all(
        agents.map((a) => api.getAgentRuntime(a.id).catch(() => null)),
      );
      return results.filter(Boolean);
    },
    enabled: agents.length > 0,
    staleTime: 10_000,
  });

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/ops" className="text-muted-foreground hover:text-foreground text-sm">← Observability</Link>
        <h1 className="text-2xl font-bold">Agent Readiness</h1>
      </div>

      <OpsTabs />

      {runtimes.length === 0 ? (
        <p className="text-muted-foreground text-sm">No agent runtime data available.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {runtimes.map(
            (rt) => rt && <AgentRuntimeCard key={rt.agentId} runtime={rt} />,
          )}
        </div>
      )}
    </div>
  );
}
