"use client";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { useAgentList } from "@/features/agents/hooks";
import { useAgentRuntimes } from "@/features/ops/hooks";

export default function AgentsPage() {
  const { data: agents = [] } = useAgentList();

  const { data: runtimes = [] } = useAgentRuntimes(
    agents.map((a) => a.id),
    {
      refetchInterval: 30_000,
    },
  );

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
          {runtimes.map(
            (rt) =>
              rt && (
                <div key={rt.agentId} className="rounded-lg border p-4">
                  <p className="font-semibold text-sm">{rt.agentName}</p>
                  <p className="text-xs text-muted-foreground font-mono">{rt.agentId}</p>
                </div>
              ),
          )}
        </div>
      )}
    </div>
  );
}
