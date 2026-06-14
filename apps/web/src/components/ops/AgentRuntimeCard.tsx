"use client";

import Link from "next/link";
import type { AgentRuntimeStatus } from "@/lib/api";

function runnerBadge(status: string): string {
  switch (status) {
    case "busy":     return "bg-blue-950 text-blue-400";
    case "degraded": return "bg-amber-950 text-amber-400";
    case "offline":  return "bg-red-950 text-red-400";
    default:         return "bg-muted text-muted-foreground";
  }
}

export function AgentRuntimeCard({ runtime }: { runtime: AgentRuntimeStatus }) {
  const hasSurfaces = Object.keys(runtime.surfaces).length > 0;

  return (
    <div className="rounded-lg border p-4 space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold text-foreground text-sm">{runtime.agentId}</h3>
        <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${runnerBadge(runtime.runner.status)}`}>
          {runtime.runner.status}
        </span>
      </div>
      <div className="text-sm space-y-1">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Active Runs</span>
          <span className="font-mono text-foreground">{runtime.runner.activeRunCount}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Uptime</span>
          <span className="font-mono text-foreground">
            {Math.floor(runtime.runner.uptimeMs / 1000)}s
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Checkpointer</span>
          <span className={`text-xs ${runtime.runner.checkpointerOk ? "text-green-400" : "text-red-400"}`}>
            {runtime.runner.checkpointerOk ? "OK" : "FAIL"}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Workspace</span>
          <span className={`text-xs ${runtime.runner.workspaceOk ? "text-green-400" : "text-red-400"}`}>
            {runtime.runner.workspaceOk ? "OK" : "FAIL"}
          </span>
        </div>
        {runtime.runner.lastError && (
          <div className="text-xs text-red-400">
            {runtime.runner.lastError}
          </div>
        )}

        {hasSurfaces && (
          <div className="border-t pt-2 mt-2">
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground text-xs">
                {Object.keys(runtime.surfaces).length} surface(s)
              </span>
              <Link
                href="/ops/surfaces"
                className="text-primary text-xs hover:underline"
              >
                View surfaces
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
