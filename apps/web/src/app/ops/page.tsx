import { fetchOpsRuns, fetchAgentRuntime } from "@/lib/observability";
import { RunOpsTable } from "@/components/ops/RunOpsTable";
import { AgentRuntimeCard } from "@/components/ops/AgentRuntimeCard";

async function getAgents(): Promise<Array<{ id: string; name: string }>> {
  try {
    const baseUrl = process.env.BACKEND_URL ?? "http://localhost:3000";
    const token = process.env.BACKEND_AUTH_TOKEN ?? "";
    const res = await fetch(`${baseUrl}/api/agents`, {
      headers: token ? { "x-auth-token": token } : {},
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export default async function OpsPage() {
  const [runs, agents] = await Promise.all([
    fetchOpsRuns({ limit: 50 }).catch(() => []),
    getAgents(),
  ]);

  const runtimes = (
    await Promise.all(
      agents.slice(0, 10).map((a) => fetchAgentRuntime(a.id).catch(() => null)),
    )
  ).filter(Boolean);

  return (
    <div className="container mx-auto p-6 space-y-8">
      <h1 className="text-2xl font-bold">Runtime Observability</h1>

      <section>
        <h2 className="text-lg font-semibold mb-3">Agent Runtimes</h2>
        {runtimes.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No agent runtime data available.
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {runtimes.map(
              (rt) =>
                rt && <AgentRuntimeCard key={rt.agentId} runtime={rt} />,
            )}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Recent Runs</h2>
        <div className="rounded-lg border">
          <RunOpsTable runs={runs} />
        </div>
      </section>
    </div>
  );
}
