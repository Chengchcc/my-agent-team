"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "@/lib/api";
import type { RunOpsListItem, AgentRuntimeStatus } from "@/lib/api";
import { isStaleRun, isDetachedRun, isUnhealthyAgent, hasSurfaceError } from "@/lib/ops-diagnosis";

interface NeedsAttentionProps {
  runs: RunOpsListItem[];
  runtimes: AgentRuntimeStatus[];
  heartbeatTimeoutMs: number;
}

type Severity = "critical" | "warn";

interface AttentionItem {
  severity: Severity;
  label: string;
  href: string;
  runId?: string;
  actionable: boolean;
}

const severityColor: Record<Severity, string> = {
  critical: "bg-primary",
  warn: "bg-amber-400",
};

function RecoverButton({ runId }: { runId: string }) {
  const qc = useQueryClient();
  const mut = useMutation({
    mutationFn: () => api.opsRecoverRun(runId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ops", "runs"] });
      qc.invalidateQueries({ queryKey: ["ops", "agentRuntime"] });
    },
  });

  return (
    <button
      type="button"
      disabled={mut.isPending}
      onClick={(e) => { e.preventDefault(); mut.mutate(); }}
      className="ml-auto text-xs text-primary hover:underline disabled:opacity-50 shrink-0"
    >
      {mut.isPending ? "…" : "Recover"}
    </button>
  );
}

export function NeedsAttentionList({ runs, runtimes, heartbeatTimeoutMs }: NeedsAttentionProps) {
  const items: AttentionItem[] = [];

  for (const r of runs) {
    if (isDetachedRun(r)) {
      items.push({
        severity: "critical",
        label: `Run ${r.runId.slice(0, 12)}… — Detached placeholder (agent ${r.agentName})`,
        href: `/ops/runs/${r.runId}`,
        runId: r.runId,
        actionable: true,
      });
    } else if (isStaleRun(r, heartbeatTimeoutMs)) {
      items.push({
        severity: "critical",
        label: `Run ${r.runId.slice(0, 12)}… — Heartbeat stale (${Math.floor((r.heartbeatAgeMs ?? 0) / 1000)}s, agent ${r.agentName})`,
        href: `/ops/runs/${r.runId}`,
        runId: r.runId,
        actionable: true,
      });
    }
  }

  for (const rt of runtimes) {
    if (isUnhealthyAgent(rt)) {
      items.push({
        severity: rt.runner.status === "offline" ? "critical" : "warn",
        label: `Agent ${rt.agentName} — Runner ${rt.runner.status}${rt.runner.lastError ? `: ${rt.runner.lastError}` : ""}`,
        href: `/ops/agents/${rt.agentId}`,
        actionable: false,
      });
    }
    if (hasSurfaceError(rt)) {
      for (const [surface, health] of Object.entries(rt.surfaces)) {
        if (health.status !== "running") {
          items.push({
            severity: "warn",
            label: `Agent ${rt.agentName} — ${surface} surface ${health.status}${health.lastError ? `: ${health.lastError}` : ""}`,
            href: `/ops/surfaces`,
            actionable: false,
          });
        }
      }
    }
  }

  items.sort((a, b) => (a.severity === "critical" ? -1 : 1) - (b.severity === "critical" ? -1 : 1));

  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">Nothing needs attention.</p>
    );
  }

  return (
    <ul className="space-y-1">
      {items.map((item, i) => (
        <li key={`${item.href}-${i}`}>
          <Link
            href={item.href}
            className="flex items-center gap-2 text-sm py-1 px-2 rounded hover:bg-muted transition-colors"
          >
            <span className={`w-2 h-2 rounded-full shrink-0 ${severityColor[item.severity]}`} />
            <span className="text-foreground">{item.label}</span>
            {item.actionable && item.runId && <RecoverButton runId={item.runId} />}
          </Link>
        </li>
      ))}
    </ul>
  );
}
