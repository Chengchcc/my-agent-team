"use client";

import Link from "next/link";
import type { AgentRuntimeStatus, RunOpsListItem } from "@/lib/api";

interface HealthSummaryProps {
  runs: RunOpsListItem[];
  runtimes: AgentRuntimeStatus[];
}

interface CountCard {
  label: string;
  count: number;
  warnAt: number;
  criticalAt: number;
  href?: string;
}

function CountCard({ card }: { card: CountCard }) {
  let color: string;
  if (card.count > card.criticalAt) color = "text-destructive";
  else if (card.count > card.warnAt) color = "text-[var(--chart-4)]";
  else color = "text-muted-foreground";

  const inner = (
    <div
      className={`rounded-lg border p-3 flex flex-col items-center ${card.href ? "hover:border-primary transition-colors cursor-pointer" : ""}`}
    >
      <span className={`text-2xl font-bold font-mono ${color}`}>{card.count}</span>
      <span className="text-xs text-muted-foreground mt-1">{card.label}</span>
    </div>
  );

  if (card.href) {
    return (
      <Link href={card.href} aria-label={`${card.label}: ${card.count}`}>
        {inner}
      </Link>
    );
  }
  return inner;
}

export function HealthSummary({ runs, runtimes }: HealthSummaryProps) {
  const running = runs.filter((r) => r.status === "running").length;
  const stale = 0; // runner removed — no transport to go stale
  const detached = 0; // runner removed — no transport to detach
  const degradedAgents = 0; // runner removed — no daemon health
  const surfaceErrors = runtimes.filter((rt) =>
    Object.values(rt.surfaces).some((s) => s.status !== "running"),
  ).length;

  const cards: CountCard[] = [
    {
      label: "Running",
      count: running,
      warnAt: 20,
      criticalAt: 50,
      href: "/ops/runs?status=running",
    },
    { label: "Stale", count: stale, warnAt: -1, criticalAt: 0, href: "/ops/runs?heartbeat=stale" },
    {
      label: "Detached",
      count: detached,
      warnAt: -1,
      criticalAt: 0,
      href: "/ops/runs?transport=detached",
    },
    {
      label: "Degraded Agents",
      count: degradedAgents,
      warnAt: -1,
      criticalAt: 0,
      href: "/ops/agents?health=degraded",
    },
    {
      label: "Surface Errors",
      count: surfaceErrors,
      warnAt: -1,
      criticalAt: 0,
      href: "/ops/surfaces?status=error",
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      {cards.map((card) => (
        <CountCard key={card.label} card={card} />
      ))}
    </div>
  );
}
