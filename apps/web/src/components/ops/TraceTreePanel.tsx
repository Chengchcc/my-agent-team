"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { fmtTokens } from "@/components/ops/format";
import { StatusBadge } from "@/components/ops/kit";
import { Button } from "@/components/ui/button";
import type { RunTraceBundle } from "@/lib/api";
import { formatDurationMs } from "@/lib/duration";
import { t } from "@/lib/i18n";
import { executionStatus } from "@/lib/status";

type TraceNode = RunTraceBundle["tree"];

function TreeRow({
  node,
  focusRunId,
  depth,
  agentName,
}: {
  node: TraceNode;
  focusRunId: string;
  depth: number;
  agentName: (agentId: string) => string;
}) {
  const isFocus = node.runId === focusRunId;
  const active = node.activeDurationMs !== null ? formatDurationMs(node.activeDurationMs) : "—";
  const cost = node.usage ? `$${node.usage.costUsd.toFixed(4)}` : "—";
  return (
    <div>
      <div
        className={`flex flex-wrap items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-xs ${
          isFocus ? "border border-(--primary)/40 bg-(--primary)/10" : "hover:bg-white/[0.03]"
        }`}
        style={{ marginLeft: depth * 18 }}
      >
        <StatusBadge look={executionStatus(node.status)} />
        <Link
          href={`/system/runs/${node.runId}`}
          className="font-medium text-(--ink-strong) hover:text-(--primary)"
        >
          {agentName(node.agentId)}
        </Link>
        <span className="font-mono text-[10px] text-(--mute)">
          {node.runId.slice(0, 10)} · {node.modelId.replace(/^acp\//, "")}
        </span>
        <span className="ml-auto font-mono text-[10px] text-(--mute) tabular-nums">
          {active}
          {node.humanWaitMs > 0 ? ` (+${formatDurationMs(node.humanWaitMs)} wait)` : ""} · {cost}
        </span>
      </div>
      {node.children.length > 0 && (
        <div className="mt-1 space-y-1">
          {node.children.map((child) => (
            <TreeRow
              key={child.runId}
              node={child}
              focusRunId={focusRunId}
              depth={depth + 1}
              agentName={agentName}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** ADR 0085 D3: Recursive multi-hop dispatch trace tree + frozen prompt &
 *  activated skills inspector for `/system/runs/[runId]`. */
export function TraceTreePanel({
  trace,
  agentName,
}: {
  trace: RunTraceBundle;
  agentName: (agentId: string) => string;
}) {
  const [showPrompt, setShowPrompt] = useState(false);

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-white/6 bg-(--panel) p-5">
        <h2 className="mb-3 text-[10px] tracking-[1.8px] uppercase text-(--faint)">
          {t("Dispatch trace tree")}
        </h2>
        <TreeRow node={trace.tree} focusRunId={trace.focusRunId} depth={0} agentName={agentName} />
      </section>

      <section className="rounded-2xl border border-white/6 bg-(--panel) p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[10px] tracking-[1.8px] uppercase text-(--faint)">
            {t("Frozen context snapshot")}
          </h2>
          {trace.systemPrompt && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setShowPrompt((prev) => !prev)}
            >
              {showPrompt ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              {showPrompt ? t("Hide system prompt") : t("Inspect system prompt")}
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
          <span className="text-(--faint)">{t("Activated skills")}:</span>
          {trace.skillsActivated.length === 0 ? (
            <span className="text-(--mute)">{t("none")}</span>
          ) : (
            trace.skillsActivated.map((sk) => (
              <span
                key={sk.skillName}
                className="rounded-full border border-(--primary)/30 bg-(--primary)/10 px-2 py-0.5 text-(--primary)"
              >
                {sk.skillName}
              </span>
            ))
          )}
        </div>

        {trace.ttftSamples.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-(--mute)">
            <span className="text-(--faint)">{t("Turn TTFT")}:</span>
            {trace.ttftSamples.map((s) => (
              <span key={s.turn} className="rounded border border-(--hairline) px-1.5 py-0.5">
                T{s.turn}: {s.ttftMs}ms
              </span>
            ))}
          </div>
        )}

        {trace.tree.usage && (
          <div className="font-mono text-[11px] text-(--mute)">
            {t("Cache tokens")}: {fmtTokens(trace.tree.usage.cacheReadTokens)} read ·{" "}
            {fmtTokens(trace.tree.usage.cacheWriteTokens)} write
          </div>
        )}

        {showPrompt && trace.systemPrompt && (
          <pre className="max-h-96 overflow-auto rounded-[10px] border border-(--hairline) bg-[#111a1e] p-4 font-mono text-[11px]/[1.7] whitespace-pre-wrap text-(--body)">
            {trace.systemPrompt}
          </pre>
        )}
      </section>
    </div>
  );
}
