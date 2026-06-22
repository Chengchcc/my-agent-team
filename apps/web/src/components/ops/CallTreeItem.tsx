"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

interface CallItem {
  kind: "llm" | "tool" | "interrupt";
  step: number;
  ts: number;
  model?: string;
  usage?: { input: number; output: number; cacheCreate?: number; cacheRead?: number };
  latencyMs?: number;
  ttftMs?: number | null;
  costUsd?: number | null;
  stopReason?: string;
  name?: string;
  isError?: boolean;
}

function formatToken(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatLatency(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function formatCost(usd: number | null | undefined): string {
  if (usd == null) return "unknown";
  return `$${usd.toFixed(4)}`;
}

export function CallTreeItem({ call, depth = 0 }: { call: CallItem; depth?: number }) {
  const [expanded, setExpanded] = useState(false);

  if (call.kind === "interrupt") {
    return (
      <div
        className="text-xs text-[var(--chart-4)] font-mono py-1"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        ⏸ paused (step {call.step})
      </div>
    );
  }

  return (
    <div>
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-xs font-mono py-1.5 px-2 h-auto rounded"
              style={{ paddingLeft: `${depth * 16 + 8}px` }}
            />
          }
        >
          {expanded ? (
            <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
          )}
          {call.kind === "llm" ? (
            <>
              <span className="text-[var(--chart-2)] font-medium">LLM</span>
              <span className="text-muted-foreground truncate max-w-[200px]">{call.model}</span>
              {call.usage && (
                <span className="text-muted-foreground">
                  {formatToken(call.usage.input)}→{formatToken(call.usage.output)}
                </span>
              )}
              {call.latencyMs != null && (
                <span className="text-foreground">{formatLatency(call.latencyMs)}</span>
              )}
              {call.ttftMs != null && (
                <span className="text-muted-foreground">TTFT {formatLatency(call.ttftMs)}</span>
              )}
              {call.costUsd != null && (
                <span className="text-primary ml-auto">{formatCost(call.costUsd)}</span>
              )}
              {call.costUsd == null && (
                <span className="text-muted-foreground ml-auto">unknown price</span>
              )}
            </>
          ) : (
            <>
              <span className={call.isError ? "text-destructive" : "text-[var(--chart-3)]"}>
                TOOL
              </span>
              <span className="text-foreground truncate max-w-[200px]">{call.name}</span>
              {call.latencyMs != null && (
                <span className="text-muted-foreground">{formatLatency(call.latencyMs)}</span>
              )}
              {call.isError && <span className="text-destructive ml-auto">✗ error</span>}
            </>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div
            className="pl-8 pr-2 py-1 text-[11px] text-muted-foreground font-mono space-y-0.5 border-l border-border ml-[10px]"
            style={{ marginLeft: `${depth * 16 + 16}px` }}
          >
            {call.kind === "llm" && (
              <>
                <div>model: {call.model}</div>
                <div>latency: {call.latencyMs != null ? formatLatency(call.latencyMs) : "—"}</div>
                <div>TTFT: {call.ttftMs != null ? formatLatency(call.ttftMs) : "—"}</div>
                <div>input: {call.usage?.input ?? 0} tokens</div>
                <div>output: {call.usage?.output ?? 0} tokens</div>
                {call.usage?.cacheCreate != null && (
                  <div>cache write: {call.usage.cacheCreate} tokens</div>
                )}
                {call.usage?.cacheRead != null && (
                  <div>cache read: {call.usage.cacheRead} tokens</div>
                )}
                <div>stop reason: {call.stopReason ?? "—"}</div>
                <div>cost (est.): {formatCost(call.costUsd)}</div>
              </>
            )}
            {call.kind === "tool" && (
              <>
                <div>name: {call.name}</div>
                <div>latency: {call.latencyMs != null ? formatLatency(call.latencyMs) : "—"}</div>
                <div>status: {call.isError ? "error" : "ok"}</div>
              </>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
