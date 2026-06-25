"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { AgentRuntimeStatus, RunOpsListItem } from "@/lib/api";
import { api } from "@/lib/api";

interface NeedsAttentionProps {
  runs: RunOpsListItem[];
  runtimes: AgentRuntimeStatus[];
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
      toast.success("Recovery initiated");
      qc.invalidateQueries({ queryKey: ["ops", "runs"] });
      qc.invalidateQueries({ queryKey: ["ops", "agentRuntime"] });
    },
    onError: (err) => {
      toast.error("Recover failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={mut.isPending}
      onClick={(e) => {
        e.preventDefault();
        mut.mutate();
      }}
      className="ml-auto text-xs h-auto py-0 shrink-0"
    >
      {mut.isPending ? "…" : "Recover"}
    </Button>
  );
}

export function NeedsAttentionList({ runs: _runs, runtimes }: NeedsAttentionProps) {
  const items: AttentionItem[] = [];

  // Runner removed — detached/stale detection disabled.
  // Kept: surface error detection still active.

  for (const rt of runtimes) {
    if (Object.values(rt.surfaces).some((s) => s.status !== "running")) {
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
    return <p className="text-sm text-muted-foreground">Nothing needs attention.</p>;
  }

  return (
    <ul className="space-y-1">
      {items.map((item, i) => (
        <li key={`${item.href}-${i}`}>
          <Link
            href={item.href}
            aria-label={`${item.severity}: ${item.label}`}
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
