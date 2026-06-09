"use client";

import { useMemo, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "@/lib/api";
import { routeItem, extractText } from "@/lib/timeline";
import { computeStatus } from "@/lib/run-status";
import { useConversation } from "@/hooks/useConversation";
import { Timeline } from "./Timeline";
import { DraftMessage } from "./DraftMessage";
import { Composer } from "./Composer";
import { ToolApprovalCard } from "./ToolApprovalCard";

interface ConversationCanvasProps {
  threadId: string;
  initialCurrentRun: { runId: string; status: string } | null;
}

export function ConversationCanvas({
  threadId,
  initialCurrentRun,
}: ConversationCanvasProps) {
  const {
    messages,
    draft,
    phase,
    busy,
    pendingInterrupt,
    error,
    runId,
    historyLoading,
    send,
    approve,
    deny,
    cancel,
    canceling,
    resuming,
  } = useConversation(threadId, initialCurrentRun);

  const label = computeStatus(runId, phase);

  // Thread + agent identity
  const { data: thread } = useQuery({
    queryKey: ["thread", threadId],
    queryFn: () => api.getThread(threadId),
    staleTime: 60_000,
  });
  const { data: agent } = useQuery({
    queryKey: ["agent", thread?.agentId],
    queryFn: () => api.getAgent(thread!.agentId),
    enabled: !!thread?.agentId,
    staleTime: 60_000,
  });
  const { data: identity } = useQuery({
    queryKey: ["identity", thread?.agentId],
    queryFn: () => api.getIdentity(thread!.agentId),
    enabled: !!thread?.agentId,
    staleTime: 120_000,
  });

  const heavyCount = useMemo(
    () =>
      messages.filter(
        (m) =>
          routeItem({ kind: "message", role: m.role, content: m.content }) ===
          "main",
      ).length,
    [messages],
  );

  const lastUserMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "user") return extractText(messages[i]!.content);
    }
    return null;
  }, [messages]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(messages.length);
  useEffect(() => {
    if (messages.length > prevLen.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevLen.current = messages.length;
  }, [messages.length]);

  return (
    <div className="h-full flex flex-col bg-[var(--canvas)]">
      {/* Header */}
      <div className="shrink-0 border-b border-[var(--hairline)] px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <Link href="/agents" className="text-[10px] text-[var(--mute)] hover:text-[var(--body)] transition-colors shrink-0">Agents</Link>
            {agent && <><span className="text-[var(--hairline)]">/</span><Link href={`/agents/${agent.id}`} className="text-[10px] text-[var(--mute)] hover:text-[var(--body)] transition-colors truncate">{agent.name}</Link></>}
          </div>
          <div className="flex items-center gap-3 shrink-0 ml-4">
            {label && (
              <>
                <span className={`w-1.5 h-1.5 rounded-full transition-colors duration-500 ${phase === "running" ? "animate-dot-pulse" : ""}`}
                  style={{ backgroundColor: phase === "running" ? "var(--primary)" : "var(--mute)" }} />
                <span className="text-xs tracking-[0.15em] uppercase font-semibold"
                  style={{ color: phase === "running" ? "var(--primary)" : "var(--mute)" }}>{label}</span>
              </>
            )}
            {!label && <span className="text-xs text-[var(--mute)]">Idle</span>}
            {runId && phase === "running" && (
              <button type="button" onClick={cancel} disabled={canceling}
                className="text-[10px] uppercase tracking-[0.15em] text-[var(--body)] hover:text-[var(--ink)] disabled:opacity-40 transition-colors">
                {canceling ? "Cancelling…" : "Cancel"}
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 mt-2">
          {agent && <span className="text-sm font-medium text-[var(--ink-strong)]">{agent.name}</span>}
          {agent && <span className="text-[10px] text-[var(--mute)] px-1.5 py-0.5 border border-[var(--hairline)] rounded font-[family-name:var(--font-mono)]">{agent.modelName}</span>}
          <div className="flex-1" />
        </div>
      </div>

      {/* Error bar */}
      {error && (
        <div className="shrink-0 border-b border-[var(--hairline)] bg-[var(--canvas-soft)] px-6 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-1 h-4 bg-[var(--primary)]/60 shrink-0 rounded-full" />
            <p className="text-xs text-[var(--ink)]">{error}</p>
          </div>
          {lastUserMessage && (
            <button type="button" onClick={() => send(lastUserMessage)}
              className="text-xs text-[var(--primary)] hover:text-[var(--primary-soft)] transition-colors shrink-0 ml-4">Retry</button>
          )}
        </div>
      )}

      {/* Heavy count */}
      {heavyCount > 0 && (
        <div className="shrink-0 px-6 py-1.5 border-b border-[var(--primary)]/20 bg-[var(--primary)]/[0.04]">
          <p className="text-[10px] tracking-[0.1em] uppercase text-[var(--primary)]/60 font-[family-name:var(--font-sans)] font-semibold">
            {heavyCount} heavy block{heavyCount > 1 ? "s" : ""}
          </p>
        </div>
      )}

      {/* Main scroll area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto" style={{ maxWidth: "72ch", padding: "0 1.5rem" }}>
          {historyLoading ? (
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
              {agent && <h1 className="font-[family-name:var(--font-sans)] text-2xl font-normal text-[var(--ink-strong)] mb-3" style={{ letterSpacing: "-0.65px" }}>{agent.name}</h1>}
              {identity?.soul && <p className="text-sm text-[var(--body)] mb-4 max-w-lg leading-relaxed">{identity.soul.slice(0, 200)}{identity.soul.length > 200 ? "…" : ""}</p>}
              <p className="text-sm text-[var(--mute)] mb-6">Send a message to begin working with this agent.</p>
              <p className="font-[family-name:var(--font-mono)] text-[13px] text-[var(--primary)]">&#x25B8; type to start</p>
            </div>
          ) : (
            <div className="py-4">
              <Timeline messages={messages} />
              {draft && <DraftMessage draft={draft} />}
            </div>
          )}
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
        <Composer onSend={send} disabled={busy} />
      </div>
    </div>
  );
}
