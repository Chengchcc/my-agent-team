"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { TraceOpsDetail } from "@/lib/api";

const MIN_BAR_W = 4;

function relativeTime(ts: number, baseTs: number): string {
  const ms = ts - baseTs;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function TraceWaterfall({ detail }: { detail: TraceOpsDetail }) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  if (detail.events.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No diagnostic events recorded for this trace.</p>
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
          const left = totalMs === 0 ? 0 : ((e.ts - baseTs) / totalMs) * 100;
          // Bar width: proportional to time until next event (or MIN_BAR_W for last)
          const nextTs = detail.events[i + 1]?.ts;
          const widthPct =
            totalMs === 0
              ? 100 / detail.events.length
              : nextTs
                ? Math.max(((nextTs - e.ts) / totalMs) * 100, 0.2)
                : Math.max(5, 0.5);
          const barWidth = `${widthPct}%`;

          return (
            <div key={`${e.runId}-${e.ts}-${i}`}>
              <Button
                variant="ghost"
                onClick={() => setExpandedIdx(expandedIdx === i ? null : i)}
                className="flex h-auto w-full items-center justify-start gap-3 rounded px-0 py-0.5 text-left text-xs font-normal group hover:bg-muted/30"
                aria-expanded={expandedIdx === i}
              >
                <span className="w-16 shrink-0 text-right font-mono text-muted-foreground">
                  {relativeTime(e.ts, baseTs)}
                </span>

                <div className="relative flex-1 h-5">
                  <div
                    className="absolute top-1/2 -translate-y-1/2 h-3 rounded-sm bg-primary/40 group-hover:bg-primary/70 transition-colors"
                    style={{ left: `${left}%`, width: barWidth, minWidth: MIN_BAR_W }}
                  />
                  <span
                    className="absolute top-1/2 -translate-y-1/2 text-foreground truncate"
                    style={{ left: `${Math.min(left + widthPct + 0.5, 98)}%` }}
                  >
                    {e.kind}
                  </span>
                </div>

                <span className="font-mono text-muted-foreground shrink-0">
                  {e.runId.slice(0, 8)}…
                </span>
              </Button>
              {expandedIdx === i && (
                <div className="ml-[76px] mt-1 mb-2 p-2 rounded bg-muted/30 text-xs font-mono text-muted-foreground overflow-x-auto">
                  <div className="flex gap-4 mb-1">
                    <span>kind: {e.kind}</span>
                    <span>ts: {new Date(e.ts).toISOString()}</span>
                    <span>runId: {e.runId}</span>
                    {e.attemptSeq != null && <span>attempt #{e.attemptSeq}</span>}
                  </div>
                  {Object.keys(e.payload).length > 0 && (
                    <pre className="mt-1 text-[11px] max-h-48 overflow-y-auto">
                      {JSON.stringify(e.payload, null, 2)}
                    </pre>
                  )}
                </div>
              )}
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
                href={`/ops/sessions/${r.sessionId}`}
                className="flex items-center gap-3 text-sm py-1 px-2 rounded-md hover:bg-muted transition-colors"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {r.runId.slice(0, 12)}…
                </span>
                <span className="text-foreground" title={r.agentId}>
                  {r.agentName}
                </span>
                <span className="text-muted-foreground text-xs">{r.status}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
