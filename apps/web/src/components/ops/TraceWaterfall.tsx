"use client";

import Link from "next/link";
import type { TraceOpsDetail } from "@/lib/api";

function relativeTime(ts: number, baseTs: number): string {
  const ms = ts - baseTs;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function TraceWaterfall({ detail }: { detail: TraceOpsDetail }) {
  if (detail.events.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No diagnostic events recorded for this trace.
      </p>
    );
  }

  const baseTs = detail.events[0]!.ts;
  const lastTs = detail.events[detail.events.length - 1]!.ts;
  const totalMs = lastTs - baseTs;

  return (
    <div className="space-y-4">
      {detail.mode === "local" && (
        <div className="text-xs text-muted-foreground px-3 py-2 rounded-md bg-muted">
          Local trace only — assembled from run_ops_event data. No OTLP collector connected.
        </div>
      )}

      <div className="text-xs text-muted-foreground mb-2">
        {detail.events.length} events over {totalMs}ms
      </div>

      <div className="space-y-0.5">
        {detail.events.map((e, i) => {
          const left = baseTs === lastTs ? 0 : ((e.ts - baseTs) / totalMs) * 100;
          return (
            <div key={`${e.runId}-${e.ts}-${i}`} className="flex items-center gap-3 text-xs group">
              <span className="w-16 shrink-0 text-right font-mono text-muted-foreground">
                {relativeTime(e.ts, baseTs)}
              </span>

              <div className="relative flex-1 h-5">
                <div
                  className="absolute top-1/2 -translate-y-1/2 h-3 rounded-sm bg-primary/40 group-hover:bg-primary/70 transition-colors"
                  style={{ left: `${left}%`, width: "4px" }}
                />
                <span
                  className="absolute top-1/2 -translate-y-1/2 text-foreground"
                  style={{ left: `${left + 0.5}%` }}
                >
                  {e.kind}
                </span>
              </div>

              <Link
                href={`/ops/runs/${e.runId}`}
                className="font-mono text-muted-foreground hover:text-primary transition-colors"
              >
                {e.runId.slice(0, 8)}…
              </Link>
            </div>
          );
        })}
      </div>

      {detail.runs.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-foreground mb-2">Related runs</h3>
          <div className="space-y-1">
            {detail.runs.map((r) => (
              <Link
                key={r.runId}
                href={`/ops/runs/${r.runId}`}
                className="flex items-center gap-3 text-sm py-1 px-2 rounded-md hover:bg-muted transition-colors"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {r.runId.slice(0, 12)}…
                </span>
                <span className="text-foreground">{r.agentId}</span>
                <span className="text-muted-foreground text-xs">{r.status}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
