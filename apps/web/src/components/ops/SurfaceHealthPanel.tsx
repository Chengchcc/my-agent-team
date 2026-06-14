"use client";

import type { SurfaceOpsItem } from "@/lib/api";

const LARK_STAGES = [
  "message received",
  "POST /messages ok",
  "run triggered",
  "run stream subscribed",
  "card sent",
  "card updated",
  "final ledger observed",
  "final card settled",
] as const;

export function SurfaceHealthPanel({ surface }: { surface: SurfaceOpsItem }) {
  const isLark = surface.surface === "lark";

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold text-foreground text-sm capitalize">
          {surface.surface} Surface
        </h3>
        <span
          className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
            surface.status === "running"
              ? "bg-green-950 text-green-400"
              : "bg-red-950 text-red-400"
          }`}
        >
          {surface.status}
        </span>
      </div>

      <div className="text-sm space-y-1">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Agent</span>
          <span className="font-mono text-foreground text-xs">{surface.agentId}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Last seen</span>
          <span className="text-foreground text-xs">
            {surface.lastSeenAt
              ? `${Math.floor((Date.now() - surface.lastSeenAt) / 1000)}s ago`
              : "—"}
          </span>
        </div>
        {surface.lastError && (
          <div className="text-xs text-red-400">
            Error: {surface.lastError}
          </div>
        )}
      </div>

      {isLark && (
        <div className="border-t pt-3 mt-3">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Projection Path
          </h4>
          <div className="space-y-1">
            {LARK_STAGES.map((stage) => {
              const key = stage.replace(/\s+/g, "_");
              const count = surface.counters[key] ?? surface.counters[stage];
              const hasCounter = key in surface.counters || stage in surface.counters;
              return (
                <div key={stage} className="flex justify-between text-xs">
                  <span className="text-muted-foreground">{stage}</span>
                  <span className="text-foreground">
                    {hasCounter ? (count ?? "—") : "not instrumented"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!isLark && Object.keys(surface.counters).length > 0 && (
        <div className="border-t pt-3 mt-3">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Counters
          </h4>
          <div className="space-y-1">
            {Object.entries(surface.counters).map(([key, val]) => (
              <div key={key} className="flex justify-between text-xs">
                <span className="text-muted-foreground">{key}</span>
                <span className="text-foreground">{val}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
