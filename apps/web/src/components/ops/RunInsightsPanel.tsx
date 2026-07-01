"use client";

import { useOpsRunInsights } from "@/features/ops/hooks";
import type { RunInsights } from "@/lib/api";
import { CallTreeItem } from "./CallTreeItem";

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms >= 60_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatToken(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatCost(usd: number | null): string {
  if (usd == null) return "unknown";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function RootSummary({ insights }: { insights: RunInsights }) {
  const r = insights.root;
  return (
    <div className="rounded-lg border bg-card p-4 space-y-2">
      <div className="flex items-center gap-3 text-sm">
        <span
          className={`font-semibold ${r.status === "running" ? "text-[var(--chart-2)]" : r.status === "interrupted" ? "text-[var(--chart-4)]" : "text-primary"}`}
        >
          {r.status}
        </span>
        <span className="text-muted-foreground">·</span>
        <span className="text-foreground">{formatDuration(r.totalLatencyMs)} total</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-foreground">
          {r.unknownCostCalls > 0 && r.totalCostUsd === 0 ? (
            <span className="text-muted-foreground">
              unknown ({r.unknownCostCalls} call{r.unknownCostCalls > 1 ? "s" : ""} unpriced)
            </span>
          ) : (
            <>
              {formatCost(r.totalCostUsd)}{" "}
              <span className="text-muted-foreground text-xs">
                (est.
                {r.unknownCostCalls > 0
                  ? `, ${r.unknownCostCalls} call${r.unknownCostCalls > 1 ? "s" : ""} unpriced`
                  : ""}
                )
              </span>
            </>
          )}
        </span>
      </div>
      <div className="text-xs text-muted-foreground font-mono space-y-0.5">
        <div>
          {r.llmCalls} LLM calls · {r.toolCalls} tool calls · {formatToken(r.totalInput)} in /{" "}
          {formatToken(r.totalOutput)} out
        </div>
        {r.slowestCall && (
          <div>
            ⚠ slowest: step{r.slowestCall.step} {r.slowestCall.kind} {r.slowestCall.name} (
            {formatDuration(r.slowestCall.latencyMs)})
          </div>
        )}
        {r.failedCall && (
          <div className="text-destructive">
            ✗ failed: step{r.failedCall.step} {r.failedCall.name}
          </div>
        )}
        {r.interruptedAt && (
          <div className="text-[var(--chart-4)]">⏸ interrupted at step {r.interruptedAt.step}</div>
        )}
      </div>
    </div>
  );
}

export function RunInsightsPanel({ runId }: { runId: string }) {
  const { data, isLoading, isError } = useOpsRunInsights(runId);

  // No data yet (likely old run pre-M16.3)
  if (!isLoading && !isError && data && data.calls.length === 0) {
    return (
      <div className="rounded-lg border p-4">
        <h3 className="text-sm font-semibold text-foreground mb-2">Run Insights</h3>
        <p className="text-xs text-muted-foreground">
          This run has no collected metrics (pre-M16.3 data).
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-4 space-y-4">
      <h3 className="text-sm font-semibold text-foreground">Run Insights</h3>

      {isLoading && (
        <div className="text-xs text-muted-foreground animate-pulse">Loading insights…</div>
      )}
      {isError && <div className="text-xs text-red-500">Failed to load run insights.</div>}

      {data && (
        <>
          <RootSummary insights={data} />

          {data.calls.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Call Timeline
              </h4>
              <div className="rounded-md border divide-y divide-border">
                {data.calls.map((call, i) => (
                  <CallTreeItem key={`${call.kind}-${call.ts}-${i}`} call={call} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
