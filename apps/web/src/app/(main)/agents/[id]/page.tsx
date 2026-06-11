"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useState } from "react";
import { AgentForm } from "@/components/AgentForm";
import { ConversationList } from "@/components/ConversationList";
import { IdentityPanel } from "@/components/IdentityPanel";
import { api } from "@/lib/api";

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
          <div className="h-6 w-48 bg-[var(--canvas-soft)]" />
          <div className="h-4 w-32 bg-[var(--canvas-soft)]" />
        </div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="container mx-auto px-8 py-10">
        <p className="text-sm text-[var(--mute)]">Agent not found</p>
      </div>
    );
  }

  const tabClass = (t: Tab) =>
    `pb-3 text-[10px] tracking-[2.52px] uppercase border-b transition-colors duration-300 font-[family-name:var(--font-sans)] font-semibold ${
      tab === t
        ? "border-[var(--primary)] text-[var(--ink)]"
        : "border-transparent text-[var(--mute)] hover:text-[var(--body)]"
    }`;

  return (
    <div className="h-full bg-[var(--canvas)] flex flex-col">
      {/* Header */}
      <div className="border-b border-[var(--hairline)] shrink-0">
        <div className="container mx-auto px-8 py-5">
          <div className="flex items-center gap-4">
            <h1
              className="text-2xl font-normal text-[var(--ink-strong)] font-[family-name:var(--font-sans)]"
              style={{ letterSpacing: "-0.65px" }}
            >
              {agent.name}
            </h1>

            <span className="text-[10px] tracking-[2.52px] uppercase text-[var(--mute)] border border-[var(--hairline)] rounded px-2 py-0.5 font-[family-name:var(--font-sans)] font-semibold">
              {agent.modelProvider}/{agent.modelName}
            </span>

            <AgentForm editAgent={agent} triggerLabel="Edit" />
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
      <div className="flex-1 overflow-y-auto">
        <div className="container mx-auto px-8 py-10">
          {tab === "threads" && <ConversationList agentId={id} agentName={agent?.name} />}
          {tab === "identity" && <IdentityPanel agentId={id} />}
        </div>
      </div>
    </div>
  );
}
