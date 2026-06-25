"use client";

import Link from "next/link";
import type { AgentRuntimeStatus } from "@/lib/api";

export function AgentRuntimeCard({ runtime }: { runtime: AgentRuntimeStatus }) {
  const hasSurfaces = Object.keys(runtime.surfaces).length > 0;

  return (
    <div className="rounded-lg border p-4 space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold text-foreground text-sm">{runtime.agentName}</h3>
      </div>
      <div className="text-sm">
        <div className="text-xs text-muted-foreground font-mono mb-1">{runtime.agentId}</div>

        {hasSurfaces && (
          <div className="border-t pt-2 mt-2">
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground text-xs">
                {Object.keys(runtime.surfaces).length} surface(s)
              </span>
              <Link href="/ops/surfaces" className="text-primary text-xs hover:underline">
                View surfaces
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
