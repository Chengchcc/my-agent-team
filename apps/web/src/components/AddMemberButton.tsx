"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type AgentRow } from "@/lib/api";
import { Plus, X, Bot } from "lucide-react";
import type { SenderRef } from "@/lib/conversation-reducer";

interface AddMemberButtonProps {
  conversationId: string;
  roster: Record<string, SenderRef>;
}

export function AddMemberButton({
  conversationId,
  roster,
}: AddMemberButtonProps) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const { data: agents } = useQuery({
    queryKey: ["agents"],
    queryFn: api.listAgents,
    staleTime: 60_000,
  });

  const presentMemberIds = new Set(
    Object.values(roster)
      .filter((m) => m.kind === "agent")
      .map((m) => m.memberId),
  );

  const add = useMutation({
    mutationFn: (a: AgentRow) =>
      api.addConversationMember(conversationId, {
        memberId: `agent-${a.id}`,
        kind: "agent",
        agentId: a.id,
        displayName: a.name,
      }),
    onSuccess: () => {
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["conv", conversationId] });
    },
  });

  const available = (agents ?? []).filter(
    (a) => !presentMemberIds.has(`agent-${a.id}`),
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="p-0.5 rounded hover:bg-[var(--canvas-soft)] transition-colors"
        title="Add agent"
      >
        <Plus size={14} className="text-[var(--mute)]" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20">
          <div className="bg-[var(--canvas)] rounded-lg border border-[var(--hairline)] shadow-xl w-80 max-h-96 flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--hairline)]">
              <span className="text-sm font-semibold text-[var(--ink-strong)]">
                Add Agent
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="p-0.5 rounded hover:bg-[var(--canvas-soft)]"
              >
                <X size={14} className="text-[var(--mute)]" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {available.length === 0 ? (
                <p className="text-xs text-[var(--mute)] p-2">
                  No available agents to add.
                </p>
              ) : (
                <ul className="space-y-1">
                  {available.map((a) => (
                    <li key={a.id}>
                      <button
                        type="button"
                        onClick={() => add.mutate(a)}
                        disabled={add.isPending}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-[var(--canvas-soft)] transition-colors disabled:opacity-40 text-left"
                      >
                        <Bot size={14} className="text-[var(--primary)] shrink-0" />
                        <span className="text-[var(--body)] truncate">
                          {a.name}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
