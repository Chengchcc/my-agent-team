"use client";

import { ArrowDown } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useConversation } from "@/hooks/useConversation";
import type { ConversationSnapshot } from "@/lib/api";
import { extractText } from "@/lib/timeline";
import { Composer } from "./Composer";
import { RosterList } from "./RosterList";
import { Timeline } from "./Timeline";
import { TodoPanel } from "./TodoPanel";
import { ToolApprovalCard } from "./ToolApprovalCard";

interface ConversationCanvasProps {
  conversationId: string;
  snapshot?: ConversationSnapshot | null;
}

export function ConversationCanvas({ conversationId, snapshot }: ConversationCanvasProps) {
  const { state, busy, send, toggleTriggerMode, approvalTarget, approve, deny, resuming } = useConversation(conversationId, snapshot);
  const { viewerMemberId, roster, messages, ledgerConn, error, todos, triggerMode } = state;

  // Derive status label from open-message state rather than a run phase.
  const isAwaiting = state.messages.some(
    (m) => m.sender.kind === "agent" && m.content.state === "waiting",
  );
  const label = isAwaiting ? "Awaiting Approval" : busy ? "Running" : null;

  const lastUserMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.sender.memberId === viewerMemberId) return extractText(messages[i]!.content);
    }
    return null;
  }, [messages, viewerMemberId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(messages.length);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);

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

  return (
    <div className="h-full flex flex-col bg-[var(--canvas)]">
      {/* Connection status */}
      {ledgerConn === "reconnecting" && (
        <div className="shrink-0 bg-[var(--chart-4)]/10 border-b border-[var(--chart-4)]/30 px-6 py-1 text-center">
          <span className="text-[10px] text-[var(--chart-4)]">Connection lost — reconnecting…</span>
        </div>
      )}
      {ledgerConn === "closed" && (
        <div className="shrink-0 bg-destructive/10 border-b border-destructive/30 px-6 py-1 text-center flex items-center justify-center gap-3">
          <span className="text-[10px] text-destructive">Connection closed</span>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="text-[10px] text-primary hover:underline"
          >
            Reload
          </button>
        </div>
      )}

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
                    busy ? "animate-dot-pulse" : ""
                  }`}
                  style={{
                    backgroundColor: busy ? "var(--primary)" : "var(--mute)",
                  }}
                />
                <span
                  className="text-xs tracking-[0.15em] uppercase font-semibold"
                  style={{
                    color: busy ? "var(--primary)" : "var(--mute)",
                  }}
                >
                  {label}
                </span>
              </>
            )}
            {!label && <span className="text-xs text-[var(--mute)]">Idle</span>}
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
            <Button
              onClick={() => send(lastUserMessage)}
              className="text-xs text-[var(--primary)] hover:text-[var(--primary-soft)] transition-colors shrink-0 ml-4"
            >
              Retry
            </Button>
          )}
        </div>
      )}

      <div className="flex-1 flex min-h-0 relative">
        {/* Main scroll area */}
        <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
          <div className="mx-auto" style={{ maxWidth: "72ch", padding: "0 1.5rem" }}>
            {messages.length === 0 ? (
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
              </div>
            )}
          </div>
        </div>

        {/* Scroll-to-bottom — outside scroll container so it stays fixed */}
        {scrolledUp && (
          <Button
            onClick={scrollToBottom}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 bg-[var(--canvas)] border border-[var(--hairline)] rounded-full p-2 hover:border-[var(--primary)] transition-colors"
            title="Scroll to bottom"
          >
            <ArrowDown size={14} className="text-[var(--body)]" />
          </Button>
        )}

        {/* Roster — desktop sidebar */}
        <aside className="hidden md:block shrink-0 w-56 border-l border-[var(--hairline)] overflow-y-auto p-3">
          <RosterList
            conversationId={conversationId}
            roster={roster}
            viewerMemberId={viewerMemberId}
          />
        </aside>

        {/* Roster — mobile trigger */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setRosterOpen(true)}
          className="md:hidden"
          aria-expanded={rosterOpen}
          aria-controls="roster-drawer"
        >
          Members ({Object.values(roster).filter((m) => m.kind !== "system").length})
        </Button>

        {/* Roster — mobile drawer overlay */}
        {rosterOpen && (
          <>
            <div
              className="md:hidden fixed inset-0 bg-black/40 z-40"
              onClick={() => setRosterOpen(false)}
            />
            <aside
              id="roster-drawer"
              className="md:hidden fixed right-0 top-0 bottom-0 w-64 bg-[var(--canvas)] border-l border-[var(--hairline)] z-50 overflow-y-auto p-3 shadow-lg"
              role="dialog"
              aria-label="Members"
            >
              <RosterList
                conversationId={conversationId}
                roster={roster}
                viewerMemberId={viewerMemberId}
                onClose={() => setRosterOpen(false)}
              />
            </aside>
          </>
        )}
      </div>

      {/* M17: Ledger-native approval — data from waiting revision, not run EventSource */}
      {approvalTarget && (
        <div className="shrink-0 border-t border-[var(--hairline)]">
          <ToolApprovalCard
            tool={{ id: approvalTarget.tools[0]?.id ?? "", name: approvalTarget.tools[0]?.name ?? "", input: {} }}
            onApprove={approve}
            onDeny={deny}
            disabled={resuming}
          />
        </div>
      )}

      {/* Composer */}
      <div className="shrink-0 border-t border-[var(--hairline)]">
        <div className="flex items-center gap-2 px-6 pt-3">
          <Button
            onClick={toggleTriggerMode}
            className="text-[10px] tracking-[0.1em] uppercase px-2 py-0.5 rounded border border-[var(--hairline)] text-[var(--mute)] hover:text-[var(--body)] hover:border-[var(--primary)] transition-colors"
            title={
              triggerMode === "auto"
                ? "Auto: messages sent to all agents"
                : "Mention: use @ to address specific agents"
            }
          >
            {triggerMode === "auto" ? "Auto" : "@ Mention"}
          </Button>
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
