"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, UserCircle, X } from "lucide-react";
import { api } from "@/lib/api";
import type { SenderRef } from "@/lib/conversation-reducer";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { AddMemberButton } from "./AddMemberButton";

interface RosterListProps {
  conversationId: string;
  roster: Record<string, SenderRef>;
  viewerMemberId: string;
  /** If provided, renders the members header with a close button (for drawer/overlay). */
  onClose?: () => void;
}

export function RosterList({ conversationId, roster, viewerMemberId, onClose }: RosterListProps) {
  const qc = useQueryClient();

  const removeMember = useMutation({
    mutationFn: (memberId: string) => api.removeConversationMember(conversationId, memberId),
    onSuccess: () => {
      toast.success("Member removed");
      qc.invalidateQueries({ queryKey: ["conv", conversationId] });
    },
    onError: (err) => {
      toast.error("Failed to remove member", { description: err instanceof Error ? err.message : "Unknown error" });
    },
  });

  const members = Object.values(roster).filter((m) => m.kind !== "system");
  const memberCount = members.length;

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] tracking-[0.15em] uppercase text-[var(--mute)] font-semibold">
            Members ({memberCount})
          </span>
        </div>
        <div className="flex items-center gap-1">
          <AddMemberButton conversationId={conversationId} roster={roster} />
          {onClose && (
            <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close members panel">
              <X size={14} />
            </Button>
          )}
        </div>
      </div>
      <ul className="space-y-1">
        {members.map((m) => {
          const isViewer = m.memberId === viewerMemberId;
          return (
            <li key={m.memberId} className="flex items-center gap-2 text-xs py-1 group">
              {m.kind === "agent" ? (
                <Bot size={14} className="text-[var(--primary)] shrink-0" />
              ) : (
                <UserCircle size={14} className="text-[var(--mute)] shrink-0" />
              )}
              <span className="truncate text-[var(--body)] flex-1">
                {m.displayName ?? m.memberId}
                {isViewer ? " (you)" : ""}
              </span>
              {!isViewer && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => {
                    if (confirm(`Remove ${m.displayName ?? m.memberId} from conversation?`)) {
                      removeMember.mutate(m.memberId);
                    }
                  }}
                  disabled={removeMember.isPending}
                  className="opacity-0 group-hover:opacity-100 transition-all disabled:opacity-0 shrink-0"
                  title={`Remove ${m.displayName ?? m.memberId}`}
                >
                  <X size={12} className="text-[var(--mute)]" />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
