"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAgentList, useArchiveAgent } from "@/features/agents/hooks";

export function AgentList() {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const { data: agents, isLoading } = useAgentList();
  const archive = useArchiveAgent();

  function handleArchive(id: string) {
    setConfirmingId(id);
    archive.mutate(id, {
      onSuccess: () => {
        toast.success("Agent archived");
        setConfirmingId(null);
      },
      onError: (err) => {
        toast.error("Failed to archive agent", {
          description: err instanceof Error ? err.message : "Unknown error",
        });
      },
    });
  }

  if (isLoading) {
    return (
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="border border-[var(--hairline)] rounded-lg bg-[var(--canvas)] p-8 animate-pulse"
          >
            <div className="h-5 w-32 bg-[var(--canvas-soft)] mb-3" />
            <div className="h-4 w-24 bg-[var(--canvas-soft)]" />
          </div>
        ))}
      </div>
    );
  }

  const active = (agents ?? []).filter((a) => !a.archivedAt);

  if (active.length === 0) {
    return (
      <div className="py-24 text-center">
        <p className="text-lg text-[var(--mute)] mb-2 font-[family-name:var(--font-sans)]">
          No agents yet
        </p>
        <p className="text-sm text-[var(--mute)]">Create your first agent to begin.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
      {active.map((agent, i) => (
        <div key={agent.id} className="relative group">
          <Link
            href={`/team/${agent.id}`}
            className="block border border-[var(--hairline)] rounded-lg bg-[var(--canvas)] p-8
                       hover:border-[var(--primary)] transition-colors duration-300
                       animate-fade-in"
            style={{
              animationDelay: `${i * 0.08}s`,
              animationFillMode: "both",
            }}
          >
            <h3
              className="text-xl font-normal text-[var(--ink-strong)] tracking-tight font-[family-name:var(--font-sans)]"
              style={{ letterSpacing: "-0.65px" }}
            >
              {agent.name}
            </h3>

            <div className="mt-3 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--primary)] opacity-60" />
              <span
                className="text-xs text-[var(--mute)] tracking-wider uppercase font-[family-name:var(--font-sans)] font-semibold"
                style={{ letterSpacing: "2.52px" }}
              >
                {agent.modelProvider}/{agent.modelName}
              </span>
            </div>

            <div className="mt-4 flex items-center gap-3 text-[10px] text-[var(--mute)]">
              <span className="border border-[var(--hairline)] rounded-sm px-1.5 py-0.5 uppercase tracking-[0.15em] font-[family-name:var(--font-sans)] font-semibold">
                {agent.permissionMode}
              </span>
              <span>
                {new Date(agent.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </div>
          </Link>

          {/* Delete / archive controls */}
          {confirmingId === agent.id ? (
            <div className="absolute top-3 right-3 flex gap-1">
              <Button
                size="xs"
                variant="secondary"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleArchive(agent.id);
                }}
                disabled={archive.isPending}
              >
                Confirm
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setConfirmingId(null);
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="xs"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setConfirmingId(agent.id);
              }}
              className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
            >
              Archive
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
