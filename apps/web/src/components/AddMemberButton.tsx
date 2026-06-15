"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { type AgentRow, api } from "@/lib/api";
import type { SenderRef } from "@/lib/conversation-reducer";
import { Button } from "@/components/ui/button";

interface AddMemberButtonProps {
  conversationId: string;
  roster: Record<string, SenderRef>;
}

export function AddMemberButton({ conversationId, roster }: AddMemberButtonProps) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const { data: agents } = useQuery({
    queryKey: ["agents"],
    queryFn: api.listAgents,
    staleTime: 60_000,
  });

  const presentMemberIds = useMemo(
    () =>
      new Set(
        Object.values(roster)
          .filter((m) => m.kind === "agent")
          .map((m) => m.memberId),
      ),
    [roster],
  );

  // Sort: available agents first, already-joined agents at bottom
  const sorted = useMemo(() => {
    const list = agents ?? [];
    return [...list].sort((a, b) => {
      const aPresent = presentMemberIds.has(a.id);
      const bPresent = presentMemberIds.has(b.id);
      if (aPresent === bPresent) return 0;
      return aPresent ? 1 : -1;
    });
  }, [agents, presentMemberIds]);

  const add = useMutation({
    mutationFn: (a: AgentRow) =>
      api.addConversationMember(conversationId, {
        memberId: a.id,
        kind: "agent",
        agentId: a.id,
        displayName: a.name,
      }),
    onSuccess: () => {
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["conv", conversationId] });
    },
  });

  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => setOpen(true)}
        title="Add agent"
      >
        <Plus size={14} />
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
          <div className="bg-[var(--canvas)] rounded-lg border border-[var(--hairline)] shadow-xl w-80 max-h-96 flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--hairline)]">
              <span className="text-sm font-semibold text-[var(--ink-strong)]">Add Agent</span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setOpen(false)}
              >
                <X size={14} />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {sorted.length === 0 ? (
                <p className="text-xs text-[var(--mute)] p-2">No agents available.</p>
              ) : (
                <ul className="space-y-1">
                  {sorted.map((a) => {
                    const isPresent = presentMemberIds.has(a.id);
                    return (
                      <li key={a.id}>
                        <button
                          type="button"
                          onClick={() => add.mutate(a)}
                          disabled={isPresent || add.isPending}
                          className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-[var(--canvas-soft)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-left"
                          title={isPresent ? "Already in this conversation" : undefined}
                        >
                          <Bot size={14} className="text-[var(--primary)] shrink-0" />
                          <span className="text-[var(--body)] truncate flex-1">{a.name}</span>
                          {isPresent && <Check size={12} className="text-[var(--mute)] shrink-0" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
