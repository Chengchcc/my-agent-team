"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { runEventsQuery } from "@/features/ops/queries";
import { formatDurationMs } from "@/lib/duration";
import { t } from "@/lib/i18n";

type RunEvent = { seq: number; type: string; data: Record<string, unknown>; ts: number };

export interface WaitIntervalProp {
  readonly actionId: string;
  readonly kind: string;
  readonly start: number;
  readonly end: number;
  readonly owner: string | null;
}

export interface ToolPayloadProp {
  readonly input?: string;
  readonly output?: string;
  readonly isError?: boolean;
}

type Phase = {
  kind: "tool" | "model" | "wait";
  name: string;
  callId?: string;
  isError?: boolean;
  start: number;
  end: number;
};

const MIN_SEGMENT_MS = 50;
const MAX_ROWS = 60;

const PHASE_COLOR: Record<Phase["kind"], string> = {
  tool: "var(--primary)",
  model: "var(--accent-violet)",
  wait: "var(--warn)",
};

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return formatDurationMs(ms);
}

/** ADR 0085 D2/D3: Three-phase waterfall (model / tool / human wait).
 *  Human wait intervals from `pending_action` are placed explicitly so
 *  HITL pause time is never misattributed to model inference latency. */
function buildPhases(
  events: RunEvent[],
  waitIntervals: readonly WaitIntervalProp[],
  startTs: number,
  endTs: number,
): Phase[] {
  const open = new Map<string, { name: string; start: number }>();
  const fixedSpans: Phase[] = [];
  for (const e of events) {
    if (e.type === "native_tool_started" || e.type === "tool_started") {
      const callId = String(e.data.callId ?? "");
      if (callId) open.set(callId, { name: String(e.data.toolName ?? "tool"), start: e.ts });
    } else if (e.type === "native_tool_completed" || e.type === "tool_completed") {
      const callId = String(e.data.callId ?? "");
      const opened = open.get(callId);
      if (!opened) continue;
      open.delete(callId);
      const res = e.data.result as Record<string, unknown> | undefined;
      fixedSpans.push({
        kind: "tool",
        name: opened.name,
        callId,
        isError: res?.isError === true,
        start: opened.start,
        end: e.ts,
      });
    }
  }
  for (const w of waitIntervals) {
    if (w.end > w.start) {
      fixedSpans.push({
        kind: "wait",
        name: `human wait (${w.kind})`,
        start: w.start,
        end: w.end,
      });
    }
  }
  fixedSpans.sort((a, b) => a.start - b.start);

  const phases: Phase[] = [];
  let cursor = startTs;
  for (const span of fixedSpans) {
    if (span.start - cursor >= MIN_SEGMENT_MS) {
      phases.push({ kind: "model", name: "model turn", start: cursor, end: span.start });
    }
    phases.push(span);
    cursor = Math.max(cursor, span.end);
  }
  if (endTs - cursor >= MIN_SEGMENT_MS) {
    phases.push({ kind: "model", name: "model turn", start: cursor, end: endTs });
  }
  return phases;
}

export function RunWaterfall({
  runId,
  startTs,
  endTs,
  waitIntervals = [],
  toolPayloads = {},
}: {
  runId: string;
  startTs: number;
  endTs: number | null;
  waitIntervals?: readonly WaitIntervalProp[];
  toolPayloads?: Readonly<Record<string, ToolPayloadProp>>;
}) {
  const telemetry = useQuery(runEventsQuery(runId));
  const [expandedCallId, setExpandedCallId] = useState<string | null>(null);
  const events = (telemetry.data?.events ?? []) as RunEvent[];
  if (events.length === 0 && waitIntervals.length === 0) {
    return (
      <p className="text-sm text-(--mute)">
        {t(
          "No telemetry events for this run — the waterfall appears after the run emits tool activity.",
        )}
      </p>
    );
  }

  const lastEventTs = events.at(-1)?.ts ?? startTs;
  const totalEnd = endTs ?? lastEventTs;
  const total = Math.max(1, totalEnd - startTs);
  const phases = buildPhases(events, waitIntervals, startTs, totalEnd);
  const toolTime = phases
    .filter((p) => p.kind === "tool")
    .reduce((sum, p) => sum + (p.end - p.start), 0);
  const waitTime = phases
    .filter((p) => p.kind === "wait")
    .reduce((sum, p) => sum + (p.end - p.start), 0);
  const modelTime = Math.max(0, total - toolTime - waitTime);

  return (
    <div className="space-y-3">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-(--panel2)">
        {phases.map((phase, i) => {
          const width = ((phase.end - phase.start) / total) * 100;
          if (width < 0.2) return null;
          return (
            <div
              key={i}
              className="h-full"
              style={{
                width: `${width}%`,
                backgroundColor: phase.isError ? "var(--err)" : PHASE_COLOR[phase.kind],
                opacity: 0.85,
              }}
              title={`${phase.name} ${fmtDuration(phase.end - phase.start)}`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-4 font-mono text-[10px] uppercase tracking-kicker text-(--mute)">
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-(--primary)" /> {t("tools")}{" "}
          {fmtDuration(toolTime)}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-(--accent-violet)" /> {t("model")}{" "}
          {fmtDuration(modelTime)}
        </span>
        {waitTime > 0 && (
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-(--warn)" /> {t("human wait")}{" "}
            {fmtDuration(waitTime)}
          </span>
        )}
        <span className="ml-auto text-(--faint)">
          {t("active time")} {fmtDuration(Math.max(0, total - waitTime))} · {t("total")}{" "}
          {fmtDuration(total)}
        </span>
      </div>
      <div className="divide-y divide-(--hairline)">
        {phases.slice(0, MAX_ROWS).map((phase, i) => {
          const duration = phase.end - phase.start;
          const pct = Math.round((duration / total) * 100);
          const payload = phase.callId ? toolPayloads[phase.callId] : undefined;
          const expandable = Boolean(phase.callId && (payload?.input || payload?.output));
          const isOpen = expandable && expandedCallId === phase.callId;
          const barColor = phase.isError ? "var(--err)" : PHASE_COLOR[phase.kind];
          return (
            <div key={i} className="py-1">
              <div
                className={`flex items-center gap-2 font-mono text-[11px] ${
                  expandable ? "cursor-pointer rounded px-1 hover:bg-white/[0.03]" : ""
                }`}
                onClick={
                  expandable
                    ? () => setExpandedCallId(isOpen ? null : (phase.callId ?? null))
                    : undefined
                }
              >
                {expandable ? (
                  isOpen ? (
                    <ChevronDown className="size-3 shrink-0 text-(--mute)" />
                  ) : (
                    <ChevronRight className="size-3 shrink-0 text-(--mute)" />
                  )
                ) : (
                  <span
                    className="size-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: barColor }}
                  />
                )}
                <span
                  className={`w-44 shrink-0 truncate ${
                    phase.isError ? "text-(--err)" : "text-(--ink)"
                  }`}
                >
                  {phase.name}
                </span>
                <span className="w-16 shrink-0 text-right text-(--mute) tabular-nums">
                  {fmtDuration(duration)}
                </span>
                <span className="w-10 shrink-0 text-right text-(--faint) tabular-nums">{pct}%</span>
                <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-(--panel2)">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max(1, (duration / total) * 100)}%`,
                      backgroundColor: barColor,
                    }}
                  />
                </div>
              </div>
              {isOpen && payload && (
                <div className="mt-2 ml-5 space-y-2 rounded-[8px] border border-(--hairline) bg-[#111a1e] p-3 font-mono text-[11px]">
                  {payload.input && (
                    <div>
                      <div className="mb-1 text-[9px] uppercase tracking-kicker text-(--faint)">
                        {t("Input")}
                      </div>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-(--body)">
                        {payload.input}
                      </pre>
                    </div>
                  )}
                  {payload.output && (
                    <div>
                      <div
                        className={`mb-1 text-[9px] uppercase tracking-kicker ${
                          payload.isError ? "text-(--err)" : "text-(--faint)"
                        }`}
                      >
                        {payload.isError ? t("Error output") : t("Output")}
                      </div>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-(--body)">
                        {payload.output}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {phases.length > MAX_ROWS && (
          <p className="pt-1 text-[10px] text-(--faint)">
            +{phases.length - MAX_ROWS} more segments
          </p>
        )}
      </div>
    </div>
  );
}
