"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { ThreadList } from "@/components/ThreadList";
import { IdentityPanel } from "@/components/IdentityPanel";

type Tab = "threads" | "identity";

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>("threads");
  const { data: agent, isLoading } = useQuery({
    queryKey: ["agent", id],
    queryFn: () => api.getAgent(id),
  });

  if (isLoading) {
    return (
      <div className="container mx-auto px-8 py-10">
        <div className="animate-pulse space-y-3">
          <div className="h-6 w-48 bg-[var(--warm-gray)]" />
          <div className="h-4 w-32 bg-[var(--warm-gray)]" />
        </div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="container mx-auto px-8 py-10">
        <p className="font-[family-name:var(--font-heading)] text-[var(--warm-gray-dark)]">
          Agent not found
        </p>
      </div>
    );
  }

  const tabClass = (t: Tab) =>
    `pb-3 font-[family-name:var(--font-mono)] text-[10px] tracking-[0.15em] uppercase border-b transition-colors duration-300 ${
      tab === t
        ? "border-[var(--brass)] text-[var(--charcoal)]"
        : "border-transparent text-[var(--warm-gray-dark)] hover:text-[var(--charcoal)]"
    }`;

  return (
    <div className="min-h-screen bg-[var(--cream)]">
      {/* Header */}
      <div className="border-b border-[var(--border-color)]">
        <div className="container mx-auto px-8 py-6">
          <Link
            href="/agents"
            className="font-[family-name:var(--font-mono)] text-[10px] tracking-[0.15em] uppercase text-[var(--warm-gray-dark)] hover:text-[var(--charcoal)] transition-colors"
          >
            ← Agents
          </Link>

          <div className="mt-4 flex items-center gap-4">
            {/* Status dot */}
            <span className="w-2 h-2 rounded-full bg-[var(--teal)]" />

            <h1 className="font-[family-name:var(--font-heading)] text-2xl font-medium text-[var(--charcoal)]">
              {agent.name}
            </h1>

            <span className="font-[family-name:var(--font-mono)] text-[10px] tracking-[0.15em] uppercase text-[var(--warm-gray-dark)] border border-[var(--border-color)] px-2 py-0.5">
              {agent.modelProvider}/{agent.modelName}
            </span>
          </div>

          {/* Tabs */}
          <div className="flex gap-8 mt-6" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "threads"}
              className={tabClass("threads")}
              onClick={() => setTab("threads")}
            >
              Threads
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "identity"}
              className={tabClass("identity")}
              onClick={() => setTab("identity")}
            >
              Persona &amp; Memory
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="container mx-auto px-8 py-10">
        {tab === "threads" && <ThreadList agentId={id} />}
        {tab === "identity" && <IdentityPanel agentId={id} />}
      </div>
    </div>
  );
}
