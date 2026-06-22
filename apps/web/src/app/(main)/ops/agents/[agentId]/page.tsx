"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AgentRuntimeCard } from "@/components/ops/AgentRuntimeCard";
import { QueryState } from "@/components/ops/QueryState";
import { RunOpsTable } from "@/components/ops/RunOpsTable";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { api } from "@/lib/api";

export default function AgentRuntimePage() {
  const { agentId } = useParams<{ agentId: string }>();

  const runtimeQuery = useQuery({
    queryKey: ["ops", "agentRuntime", agentId],
    queryFn: () => api.getAgentRuntime(agentId),
    enabled: !!agentId,
    refetchInterval: 10_000,
  });

  const runsQuery = useQuery({
    queryKey: ["ops", "runs", agentId],
    queryFn: () => api.listOpsRuns({ agentId, limit: 20 }),
    enabled: !!agentId,
    refetchInterval: 10_000,
  });

  return (
    <div className="container mx-auto p-6 space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/ops">Observability
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink href="/ops/agents">Agent Readiness
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{runtimeQuery.data?.agentName ?? agentId}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-1">
          <QueryState query={runtimeQuery}>
            {(runtime) => <AgentRuntimeCard runtime={runtime} />}
          </QueryState>
        </div>
        <div className="md:col-span-2">
          <section>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              Recent Runs
            </h2>
            <div className="rounded-lg border">
              <QueryState query={runsQuery}>
                {(runs) => (
                  <RunOpsTable
                    runs={runs}
                    heartbeatTimeoutMs={runtimeQuery.data?.heartbeatTimeoutMs}
                  />
                )}
              </QueryState>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
