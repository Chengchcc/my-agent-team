import { fetchAgentRuntime, fetchOpsRuns } from "@/lib/observability";
import { AgentRuntimeCard } from "@/components/ops/AgentRuntimeCard";
import { RunOpsTable } from "@/components/ops/RunOpsTable";
import Link from "next/link";
import { notFound } from "next/navigation";

export default async function AgentRuntimePage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = await params;
  const [runtime, runs] = await Promise.all([
    fetchAgentRuntime(agentId),
    fetchOpsRuns({ agentId, limit: 20 }).catch(() => []),
  ]);
  if (!runtime) notFound();

  return (
    <div className="container mx-auto p-6 space-y-8">
      <div className="flex items-center gap-3">
        <Link
          href="/ops"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Ops
        </Link>
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
