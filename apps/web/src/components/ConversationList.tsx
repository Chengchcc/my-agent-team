"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useRouter } from "next/navigation";
import { Plus, ChevronRight, Trash2, ArrowRight } from "lucide-react";

function isRecent(ts: number | null): boolean {
  if (!ts) return false;
  return Date.now() - ts < 5 * 60 * 1000;
}

export function ConversationList({ agentId, agentName }: { agentId: string; agentName?: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: conversations, isLoading } = useQuery({
    queryKey: ["conversations", agentId],
    queryFn: () => api.listConversations(agentId),
  });

  const createConversation = useMutation({
    mutationFn: async () => {
      const humanId = `human-${crypto.randomUUID().slice(0, 8)}`;
      return api.createConversation({
        members: [
          { memberId: agentId, kind: "agent", agentId, displayName: agentName },
          { memberId: humanId, kind: "human", userRef: "__legacy__", displayName: "User" },
        ],
      });
    },
    onSuccess: (conv) => {
      queryClient.invalidateQueries({ queryKey: ["conversations", agentId] });
      router.push(`/conversations/${conv.conversationId}`);
    },
  });

  const deleteConversation = useMutation({
    mutationFn: (convId: string) => api.deleteConversation(convId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations", agentId] });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={`sk-${i}`} className="animate-pulse h-12 bg-[var(--canvas-soft)] rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-[var(--mute)]">
          {(conversations ?? []).length} conversation{(conversations ?? []).length !== 1 ? "s" : ""}
        </p>
        <button
          type="button"
          onClick={() => createConversation.mutate()}
          disabled={createConversation.isPending}
          className="flex items-center gap-1 text-xs text-[var(--primary)] hover:text-[var(--primary-soft)] transition-colors disabled:opacity-40 font-medium"
        >
          <Plus size={14} />
          New Conversation
        </button>
      </div>

      {(conversations ?? []).length === 0 ? (
        <div className="text-center py-12">
          <p className="text-sm text-[var(--mute)] mb-2">No conversations yet</p>
          <button
            type="button"
            onClick={() => createConversation.mutate()}
            className="text-xs text-[var(--primary)] hover:text-[var(--primary-soft)] transition-colors font-medium"
          >
            Create your first conversation
          </button>
        </div>
      ) : (
        <div className="space-y-0.5">
          {(conversations ?? []).map((conv, i) => (
            <div
              key={conv.conversationId}
              role="button"
              tabIndex={0}
              onClick={() => router.push(`/conversations/${conv.conversationId}`)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  router.push(`/conversations/${conv.conversationId}`);
                }
              }}
              className="w-full text-left border border-[var(--hairline)] rounded-lg
                         hover:border-[var(--primary)] transition-colors duration-200
                         animate-fade-in bg-[var(--canvas)] cursor-pointer p-3 flex items-center justify-between"
              style={{ animationDelay: `${i * 0.06}s`, animationFillMode: "both" }}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-[var(--ink-strong)] truncate">
                  {conv.title ?? `Conversation ${conv.conversationId.slice(0, 8)}`}
                </p>
                <p className="text-[10px] text-[var(--mute)] mt-0.5">
                  {conv.members.length} member{conv.members.length !== 1 ? "s" : ""}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-3">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm("Delete this conversation?")) {
                      deleteConversation.mutate(conv.conversationId);
                    }
                  }}
                  className="p-1 text-[var(--hairline)] hover:text-red-400 transition-colors opacity-60 hover:opacity-100"
                  title="Delete conversation"
                >
                  <Trash2 size={14} />
                </button>
                <ChevronRight size={14} className="text-[var(--hairline)]" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
