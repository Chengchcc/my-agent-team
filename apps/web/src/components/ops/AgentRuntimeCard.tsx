import type { AgentRuntimeStatus } from "@/lib/api";

const statusColor: Record<string, string> = {
  idle: "bg-gray-100 text-gray-600",
  busy: "bg-blue-100 text-blue-800",
  degraded: "bg-orange-100 text-orange-800",
  offline: "bg-red-100 text-red-800",
  unknown: "bg-gray-100 text-gray-400",
};

export function AgentRuntimeCard({
  runtime,
}: {
  runtime: AgentRuntimeStatus;
}) {
  return (
    <div className="rounded-lg border p-4 space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold">{runtime.agentId}</h3>
        <span
          className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
            statusColor[runtime.runner.status] ?? "bg-gray-100"
          }`}
        >
          {runtime.runner.status}
        </span>
      </div>
      <div className="text-sm space-y-1">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Active Runs</span>
          <span className="font-mono">{runtime.runner.activeRunCount}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Uptime</span>
          <span className="font-mono">
            {Math.floor(runtime.runner.uptimeMs / 1000)}s
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Checkpointer</span>
          <span
            className={
              runtime.runner.checkpointerOk
                ? "text-green-600 text-xs"
                : "text-red-600 text-xs"
            }
          >
            {runtime.runner.checkpointerOk ? "OK" : "FAIL"}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Workspace</span>
          <span
            className={
              runtime.runner.workspaceOk
                ? "text-green-600 text-xs"
                : "text-red-600 text-xs"
            }
          >
            {runtime.runner.workspaceOk ? "OK" : "FAIL"}
          </span>
        </div>
        {runtime.runner.lastError && (
          <div className="text-red-600 text-xs">
            {runtime.runner.lastError}
          </div>
        )}
        {Object.entries(runtime.surfaces).map(([surface, health]) => (
          <div key={surface} className="border-t pt-2 mt-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground capitalize">
                {surface} Surface
              </span>
              <span
                className={
                  health.status === "running"
                    ? "text-green-600 text-xs"
                    : "text-red-600 text-xs"
                }
              >
                {health.status}
              </span>
            </div>
            {health.lastError && (
              <div className="text-red-600 text-xs mt-1">
                {health.lastError}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
