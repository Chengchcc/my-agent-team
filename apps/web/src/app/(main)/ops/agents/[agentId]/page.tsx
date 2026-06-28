"use client";

import { useParams } from "next/navigation";
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
import { useOpsAgentRuntime, useOpsRuns } from "@/features/ops/hooks";

export default function AgentRuntimePage() {
  const { agentId } = useParams<{ agentId: string }>();

  const runtimeQuery = useOpsAgentRuntime(agentId);

  const runsQuery = useOpsRuns({ agentId });

  return (
    <div className="container mx-auto p-6 space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/ops">Observability</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink href="/ops/agents">Agent Readiness</BreadcrumbLink>
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
            {(runtime) => (
              <div className="rounded-lg border p-4 space-y-2">
                <p className="font-semibold text-sm">{runtime.agentName}</p>
                <p className="text-xs text-muted-foreground font-mono">{runtime.agentId}</p>
              </div>
            )}
          </QueryState>
        </div>
        <div className="md:col-span-2">
          <section>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              Recent Runs
            </h2>
            <div className="rounded-lg border">
              <QueryState query={runsQuery}>{(runs) => <RunOpsTable runs={runs} />}</QueryState>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
