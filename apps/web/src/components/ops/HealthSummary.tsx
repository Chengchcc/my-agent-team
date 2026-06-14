"use client";

import type { RunOpsListItem, AgentRuntimeStatus } from "@/lib/api";
import { isStaleRun, isDetachedRun, isUnhealthyAgent, hasSurfaceError } from "@/lib/ops-diagnosis";

interface HealthSummaryProps {
  runs: RunOpsListItem[];
  runtimes: AgentRuntimeStatus[];
  heartbeatTimeoutMs: number;
}

interface CountCard {
  label: string;
  count: number;
  warnAt: number;
  criticalAt: number;
}

function CountCard({ card }: { card: CountCard }) {
  let color: string;
  if (card.count > card.criticalAt) color = "text-red-400";
  else if (card.count > card.warnAt) color = "text-amber-400";
  else color = "text-muted-foreground";

  return (
    <div className="rounded-lg border p-3 flex flex-col items-center">
      <span className={`text-2xl font-bold font-mono ${color}`}>
        {card.count}
      </span>
      <span className="text-xs text-muted-foreground mt-1">{card.label}</span>
    </div>
  );
}

export function HealthSummary({ runs, runtimes, heartbeatTimeoutMs }: HealthSummaryProps) {
  const running = runs.filter((r) => r.status === "running").length;
  const stale = runs.filter((r) => isStaleRun(r, heartbeatTimeoutMs)).length;
  const detached = runs.filter((r) => isDetachedRun(r)).length;
  const degradedAgents = runtimes.filter((rt) => isUnhealthyAgent(rt)).length;
  const surfaceErrors = runtimes.filter((rt) => hasSurfaceError(rt)).length;

  const cards: CountCard[] = [
    { label: "Running", count: running, warnAt: 20, criticalAt: 50 },
    { label: "Stale", count: stale, warnAt: -1, criticalAt: 0 },
    { label: "Detached", count: detached, warnAt: -1, criticalAt: 0 },
    { label: "Degraded Agents", count: degradedAgents, warnAt: -1, criticalAt: 0 },
    { label: "Surface Errors", count: surfaceErrors, warnAt: -1, criticalAt: 0 },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      {cards.map((card) => (
        <CountCard key={card.label} card={card} />
      ))}
    </div>
  );
}
