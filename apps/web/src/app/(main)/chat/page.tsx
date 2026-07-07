"use client";

import { ChevronRight, MessageSquareIcon, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCreateConversation, useRecentConversations } from "@/features/conversations/hooks";

export default function ChatOverviewPage() {
  const router = useRouter();
  const { data, isLoading } = useRecentConversations();
  const createConv = useCreateConversation();
  const [input, setInput] = useState("");

  function handleCreate() {
    if (!input.trim()) return;
    createConv.mutate(
      {
        members: [
          { memberId: "default", kind: "agent", agentId: "default", displayName: "Assistant" },
          {
            memberId: `human-${crypto.randomUUID().slice(0, 8)}`,
            kind: "human",
            displayName: "User",
          },
        ],
      },
      {
        onSuccess: (conv) => {
          router.push(`/chat/${conv.conversationId}`);
        },
        onError: (err) => {
          toast.error("Failed to create conversation", {
            description: err instanceof Error ? err.message : "Unknown error",
          });
        },
      },
    );
  }

  const conversations = data ?? [];

  return (
    <div className="h-full bg-[var(--canvas)]">
      {/* Top bar */}
      <div className="border-b border-[var(--hairline)]">
        <div className="container mx-auto px-8 py-5">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>Chat</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </div>

      {/* Content */}
      <div className="container mx-auto px-8 py-10 max-w-3xl">
        {/* Composer */}
        <div className="border border-[var(--hairline)] rounded-lg bg-[var(--canvas)] p-3 mb-8">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleCreate();
              }
            }}
            placeholder="Send a message to start a new conversation…"
            className="min-h-24 resize-none border-0 bg-transparent text-sm text-[var(--ink-strong)] placeholder:text-[var(--mute)] focus-visible:ring-0"
          />
          <div className="flex items-center justify-end mt-2">
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={!input.trim() || createConv.isPending}
            >
              <Send size={14} />
              Start
            </Button>
          </div>
        </div>

        {/* Recent conversations */}
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs text-[var(--mute)]">
            {conversations.length} conversation{conversations.length !== 1 ? "s" : ""}
          </p>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div
                key={`sk-${i}`}
                className="animate-pulse h-16 bg-[var(--canvas-soft)] rounded-lg"
              />
            ))}
          </div>
        ) : conversations.length === 0 ? (
          <div className="text-center py-12">
            <MessageSquareIcon size={28} className="text-[var(--mute)] mx-auto mb-2" />
            <p className="text-sm text-[var(--mute)]">No conversations yet</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {conversations.map((conv, i) => (
              <div
                key={conv.conversationId}
                role="button"
                tabIndex={0}
                onClick={() => router.push(`/chat/${conv.conversationId}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    router.push(`/chat/${conv.conversationId}`);
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
                  <div className="flex items-center gap-2 mt-1">
                    {/* Member avatars */}
                    <div className="flex -space-x-1.5">
                      {conv.members.slice(0, 4).map((m) => (
                        <span
                          key={m.memberId}
                          className="inline-flex items-center justify-center h-5 w-5 rounded-full
                                     border border-[var(--canvas)] bg-[var(--canvas-soft)]
                                     text-[9px] font-medium text-[var(--mute)]"
                          title={m.displayName ?? m.memberId}
                        >
                          {(m.displayName ?? m.memberId).charAt(0).toUpperCase()}
                        </span>
                      ))}
                    </div>
                    <p className="text-[10px] text-[var(--mute)]">
                      {new Date(conv.createdAt).toLocaleString()}
                    </p>
                  </div>
                </div>
                <ChevronRight size={14} className="text-[var(--hairline)] shrink-0 ml-3" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
