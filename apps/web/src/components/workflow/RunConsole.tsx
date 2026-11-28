"use client";

import { useState } from "react";
import { t } from "@/lib/i18n";
import type { TraceEvent } from "./ExecutionTraceView";

/** Colored tag per event kind (Obsidian telemetry tags). Unknown events read
 *  as a neutral `log`. */
const EVENT_TAG: Record<string, string> = {
  execution_started: "border-(--primary)/30 bg-(--primary)/10 text-(--primary)",
  node_started: "border-(--accent-violet)/30 bg-(--accent-violet)/10 text-(--accent-violet)",
  node_completed: "border-(--ok)/30 bg-(--ok)/10 text-(--ok)",
  node_failed: "border-(--err)/30 bg-(--err)/10 text-(--err)",
  routing: "border-(--accent-violet)/30 bg-(--accent-violet)/10 text-(--accent-violet)",
  agent_send: "border-(--warn)/30 bg-(--warn)/10 text-(--warn)",
  node_agent_started: "border-(--info)/30 bg-(--info)/10 text-(--info)",
  human_gate: "border-(--accent-violet)/30 bg-(--accent-violet)/10 text-(--accent-violet)",
  execution_terminal: "border-(--primary)/30 bg-(--primary)/10 text-(--primary)",
};

/** Stands in for a node the event does not name. */
const UNKNOWN_NODE = "?";

function tagFor(event: string): string {
  return EVENT_TAG[event] ?? "border-(--hairline)/50 bg-(--canvas-soft) text-(--mute)";
}

/** Bottom run console: telemetry timeline of execution events, each with a
 *  colored status tag + timestamp + payload. */
export function RunConsole({ events }: { events: TraceEvent[] }) {
  const [openEvent, setOpenEvent] = useState<number | null>(null);
  if (events.length === 0) {
    return <div className="px-4 py-2 text-xs text-(--mute)">{t("No execution events yet.")}</div>;
  }
  return (
    <div className="max-h-56 overflow-y-auto px-4 py-2 font-code-sm text-code-sm leading-relaxed">
      {events.map((e) => (
        <div
          key={e.seq}
          className="flex items-start gap-2 border-b border-(--hairline)/40 py-1.5 last:border-b-0"
        >
          <span className="shrink-0 font-mono text-[10px] text-(--faint) tabular-nums">
            {new Date(e.ts).toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
          <span
            className={`shrink-0 rounded border px-1.5 py-0.5 font-label-caps text-label-caps font-bold uppercase ${tagFor(e.event)}`}
          >
            {t(e.event.replace(/_/g, " "))}
          </span>
          <button
            type="button"
            className="min-w-0 flex-1 text-left"
            onClick={() => setOpenEvent(openEvent === e.seq ? null : e.seq)}
          >
            <span className="truncate text-(--body)">{renderEventSummary(e.event, e.data)}</span>
            {openEvent === e.seq && (
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-(--canvas-soft) p-2 text-[10px] text-(--mute)">
                {JSON.stringify(e.data, null, 2)}
              </pre>
            )}
          </button>
        </div>
      ))}
    </div>
  );
}

/** One-line human summary of a workflow execution event payload. */
function renderEventSummary(event: string, data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>;
  const node = String(d.nodeId ?? UNKNOWN_NODE);
  switch (event) {
    case "node_started":
      return t("node {node} started", { node });
    case "node_completed":
      return d.routedTo
        ? t("node {node} completed → {to}", { node, to: String(d.routedTo) })
        : t("node {node} completed", { node });
    case "node_failed":
      return d.error
        ? t("node {node} failed: {error}", { node, error: String(d.error) })
        : t("node {node} failed", { node });
    case "node_agent_started":
      return d.agentId
        ? t("node {node} running on {agent}", { node, agent: String(d.agentId) })
        : t("node {node} agent started", { node });
    case "routing":
      return t("routed to {to}", { to: String(d.to ?? UNKNOWN_NODE) });
    case "execution_started":
      return d.triggeredBy
        ? t("execution started ({trigger})", { trigger: String(d.triggeredBy) })
        : t("execution started");
    case "execution_terminal":
      return t("execution {status}", { status: t(String(d.status ?? "terminated")) });
    default:
      return event;
  }
}
