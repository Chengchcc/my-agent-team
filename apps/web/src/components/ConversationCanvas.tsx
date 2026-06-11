"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, Bot, UserCircle, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConversation } from "@/hooks/useConversation";
import type { ConversationSnapshot } from "@/lib/api";
import { api } from "@/lib/api";
import { computeStatus } from "@/lib/run-status";
import { extractText } from "@/lib/timeline";
import { AddMemberButton } from "./AddMemberButton";
import { Composer } from "./Composer";
import { DraftMessage } from "./DraftMessage";
import { Timeline } from "./Timeline";
import { TodoPanel } from "./TodoPanel";
import { ToolApprovalCard } from "./ToolApprovalCard";

interface ConversationCanvasProps {
  conversationId: string;
  snapshot?: ConversationSnapshot | null;
}

export function ConversationCanvas({ conversationId, snapshot }: ConversationCanvasProps) {
  const {
    viewerMemberId,
    roster,
    messages,
    draft,
    phase,
    busy,
    pendingInterrupt,
    error,
    runId,
    loading,
    send,
    approve,
    deny,
    cancel,
    canceling,
    resuming,
    triggerMode,
    toggleTriggerMode,
    todos,
  } = useConversation(conversationId, snapshot);

  const label = computeStatus(runId, phase);

  const lastUserMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.sender.memberId === viewerMemberId) return extractText(messages[i]!.content);
    }
    return null;
  }, [messages, viewerMemberId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(messages.length);
  const [scrolledUp, setScrolledUp] = useState(false);

  useEffect(() => {
    if (messages.length > prevLen.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevLen.current = messages.length;
  }, [messages.length]);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setScrolledUp(!atBottom);
  }, []);

  // Resolve the primary agent for header display (first agent in roster)
  const primaryAgent = useMemo(() => {
    const agent = Object.values(roster).find((m) => m.kind === "agent");
    return agent ?? null;
  }, [roster]);

  const qc = useQueryClient();
  const removeMember = useMutation({
    mutationFn: (memberId: string) => api.removeConversationMember(conversationId, memberId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["conv", conversationId] });
    },
  });

  return (
    <div className="h-full flex flex-col bg-[var(--canvas)]">
      {/* Header */}
      <div className="shrink-0 border-b border-[var(--hairline)] px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <Link
              href="/agents"
              className="text-[10px] text-[var(--mute)] hover:text-[var(--body)] transition-colors shrink-0"
            >
              Agents
            </Link>
            {primaryAgent && (
              <>
                <span className="text-[var(--hairline)]">/</span>
                <span className="text-[10px] text-[var(--body)] truncate">
                  {primaryAgent.displayName ?? primaryAgent.memberId}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0 ml-4">
            {label && (
              <>
                <span
                  className={`w-1.5 h-1.5 rounded-full transition-colors duration-500 ${
                    phase === "running" ? "animate-dot-pulse" : ""
                  }`}
                  style={{
                    backgroundColor: phase === "running" ? "var(--primary)" : "var(--mute)",
                  }}
                />
                <span
                  className="text-xs tracking-[0.15em] uppercase font-semibold"
                  style={{
                    color: phase === "running" ? "var(--primary)" : "var(--mute)",
                  }}
                >
                  {label}
                </span>
              </>
            )}
            {!label && <span className="text-xs text-[var(--mute)]">Idle</span>}
            {runId && phase === "running" && (
              <button
                type="button"
                onClick={cancel}
                disabled={canceling}
                className="text-[10px] uppercase tracking-[0.15em] text-[var(--body)] hover:text-[var(--ink)] disabled:opacity-40 transition-colors"
              >
                {canceling ? "Cancelling…" : "Cancel"}
              </button>
            )}
          </div>
        </div>
        {primaryAgent && (
          <div className="flex items-center gap-2 mt-2">
            <span className="text-sm font-medium text-[var(--ink-strong)]">
              {primaryAgent.displayName ?? primaryAgent.memberId}
            </span>
          </div>
        )}
      </div>

      {/* M14.6: Todo progress — pinned above message stream */}
      <TodoPanel todos={todos} />

      {/* Error bar */}
      {error && (
        <div className="shrink-0 border-b border-[var(--hairline)] bg-[var(--canvas-soft)] px-6 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-1 h-4 bg-[var(--primary)]/60 shrink-0 rounded-full" />
            <p className="text-xs text-[var(--ink)]">{error}</p>
          </div>
          {lastUserMessage && (
            <button
              type="button"
              onClick={() => send(lastUserMessage)}
              className="text-xs text-[var(--primary)] hover:text-[var(--primary-soft)] transition-colors shrink-0 ml-4"
            >
              Retry
            </button>
          )}
        </div>
      )}

      <div className="flex-1 flex min-h-0 relative">
        {/* Main scroll area */}
        <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
          <div className="mx-auto" style={{ maxWidth: "72ch", padding: "0 1.5rem" }}>
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <div className="space-y-4 w-full">
                  {[1, 2, 3].map((i) => (
                    <div key={`sk-${i}`} className="animate-pulse">
                      <div className="h-2 w-8 bg-[var(--canvas-soft)] mb-2" />
                      <div className="h-3 w-3/4 bg-[var(--canvas-soft)]" />
                    </div>
                  ))}
                </div>
              </div>
            ) : messages.length === 0 && !draft ? (
              <div className="flex flex-col items-start justify-center py-24">
                {primaryAgent && (
                  <h1
                    className="font-[family-name:var(--font-sans)] text-2xl font-normal text-[var(--ink-strong)] mb-3"
                    style={{ letterSpacing: "-0.65px" }}
                  >
                    {primaryAgent.displayName ?? primaryAgent.memberId}
                  </h1>
                )}
                <p className="text-sm text-[var(--mute)] mb-6">Send a message to begin.</p>
                <p className="font-[family-name:var(--font-mono)] text-[13px] text-[var(--primary)]">
                  &#x25B8; type to start
                </p>
              </div>
            ) : (
              <div className="py-4">
                <Timeline
                  messages={messages}
                  viewerMemberId={viewerMemberId}
                  scrollContainerRef={scrollRef}
                />
                {draft && <DraftMessage draft={draft} />}
              </div>
            )}
          </div>
        </div>

        {/* Scroll-to-bottom — outside scroll container so it stays fixed */}
        {scrolledUp && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-4 right-4 z-20 bg-[var(--canvas)] border border-[var(--hairline)] rounded-full p-2 shadow-lg hover:border-[var(--primary)] transition-colors"
            title="Scroll to bottom"
          >
            <ArrowDown size={14} className="text-[var(--body)]" />
          </button>
        )}

        {/* Roster sidebar */}
        <div className="shrink-0 w-56 border-l border-[var(--hairline)] overflow-y-auto p-3">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] tracking-[0.15em] uppercase text-[var(--mute)] font-semibold">
              Members
            </span>
            <AddMemberButton conversationId={conversationId} roster={roster} />
          </div>
          <ul className="space-y-1">
            {Object.values(roster).map((m) => {
              if (m.kind === "system") return null;
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
                    <button
                      type="button"
                      onClick={() => removeMember.mutate(m.memberId)}
                      disabled={removeMember.isPending}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--canvas-soft)] transition-all disabled:opacity-0 shrink-0"
                      title={`Remove ${m.displayName ?? m.memberId}`}
                    >
                      <X size={12} className="text-[var(--mute)]" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {/* Interrupt */}
      {pendingInterrupt && (
        <div className="shrink-0 border-t border-[var(--hairline)]">
          <ToolApprovalCard
            tool={pendingInterrupt}
            onApprove={approve}
            onDeny={deny}
            disabled={resuming}
          />
        </div>
      )}

      {/* Composer */}
      <div className="shrink-0 border-t border-[var(--hairline)]">
        <div className="flex items-center gap-2 px-6 pt-3">
          <button
            type="button"
            onClick={toggleTriggerMode}
            className="text-[10px] tracking-[0.1em] uppercase px-2 py-0.5 rounded border border-[var(--hairline)] text-[var(--mute)] hover:text-[var(--body)] hover:border-[var(--primary)] transition-colors"
            title={
              triggerMode === "auto"
                ? "Auto: messages sent to all agents"
                : "Mention: use @ to address specific agents"
            }
          >
            {triggerMode === "auto" ? "Auto" : "@ Mention"}
          </button>
        </div>
        <Composer
          onSend={send}
          disabled={busy}
          roster={roster}
          autoAgentCount={Object.values(roster).filter((m) => m.kind === "agent").length}
        />
      </div>
    </div>
  );
}
