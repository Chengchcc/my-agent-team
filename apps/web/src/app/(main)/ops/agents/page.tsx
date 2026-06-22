"use client";

import { useQuery } from "@tanstack/react-query";
import { AgentRuntimeCard } from "@/components/ops/AgentRuntimeCard";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { api } from "@/lib/api";

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
            <BreadcrumbPage>Agent Readiness</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {runtimes.length === 0 ? (
        <p className="text-muted-foreground text-sm">No agent runtime data available.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {runtimes.map((rt) => rt && <AgentRuntimeCard key={rt.agentId} runtime={rt} />)}
        </div>
      )}
    </div>
  );
}
