"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import Link from "next/link";

export function AgentList() {
  const { data: agents, isLoading } = useQuery({
    queryKey: ["agents"],
    queryFn: api.listAgents,
  });

  if (isLoading) {
    return (
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="border border-[var(--border-color)] bg-[var(--paper)] p-8 animate-pulse"
          >
            <div className="h-5 w-32 bg-[var(--warm-gray)] mb-3" />
            <div className="h-4 w-24 bg-[var(--warm-gray)]" />
          </div>
        ))}
      </div>
    );
  }

  const active = (agents ?? []).filter((a) => !a.archivedAt);

  if (active.length === 0) {
    return (
      <div className="py-24 text-center">
        <p className="font-[family-name:var(--font-heading)] text-lg text-[var(--warm-gray-dark)] mb-2">
          No agents yet
        </p>
        <p className="text-sm text-[var(--warm-gray-dark)]">
          Create your first agent to begin.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
      {active.map((agent, i) => (
        <Link
          key={agent.id}
          href={`/agents/${agent.id}`}
          className="group block border border-[var(--border-color)] bg-[var(--cream)] p-8
                     hover:border-[var(--brass)] transition-colors duration-300
                     animate-fade-in"
          style={{
            animationDelay: `${i * 0.08}s`,
            animationFillMode: "both",
          }}
        >
          {/* Left accent line — appears on hover */}
          <div
            className="w-0.5 h-0 group-hover:h-8 bg-[var(--brass)] mb-3
                        transition-all duration-300 ease-out"
          />

          <h3 className="font-[family-name:var(--font-heading)] text-xl font-medium text-[var(--charcoal)] tracking-tight">
            {agent.name}
          </h3>

          <div className="mt-3 flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--teal)] opacity-60" />
            <span className="font-[family-name:var(--font-mono)] text-xs text-[var(--warm-gray-dark)] tracking-wider uppercase">
              {agent.modelProvider}/{agent.modelName}
            </span>
          </div>

          {/* Status dot row — decorative */}
          <div className="mt-4 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-500">
            <span className="w-1 h-1 rounded-full bg-[var(--border-color)]" />
            <span className="w-1 h-1 rounded-full bg-[var(--border-color)]" />
            <span className="w-1 h-1 rounded-full bg-[var(--border-color)]" />
          </div>
        </Link>
      ))}
    </div>
  );
}
