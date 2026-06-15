"use client";

import Link from "next/link";
import type { AgentRuntimeStatus } from "@/lib/api";
import { Badge } from "@/components/ui/badge";

function runnerBadgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "busy":     return "default";
    case "degraded": return "outline";
    case "offline":  return "destructive";
    default:         return "secondary";
  }
}

export function AgentRuntimeCard({ runtime }: { runtime: AgentRuntimeStatus }) {
  const hasSurfaces = Object.keys(runtime.surfaces).length > 0;

  return (
    <div className="rounded-lg border p-4 space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold text-foreground text-sm">{runtime.agentName}</h3>
        <Badge variant={runnerBadgeVariant(runtime.runner.status)} className="text-xs">
          {runtime.runner.status}
        </Badge>
      </div>
      <div className="text-sm">
        <div className="text-xs text-muted-foreground font-mono mb-1">{runtime.agentId}</div>
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
