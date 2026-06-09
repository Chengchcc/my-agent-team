"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useTimeline } from "@/hooks/useTimeline";
import { useDeltaStream } from "@/hooks/useDeltaStream";
import { Timeline } from "./Timeline";
import { Composer } from "./Composer";
import { ToolApprovalCard } from "./ToolApprovalCard";
import { routeItem, extractText } from "@/lib/timeline";
import { statusLabel as computeStatus } from "@/lib/run-status";

interface ConversationCanvasProps {
  threadId: string;
  initialCurrentRun: { runId: string; status: string } | null;
}

export function ConversationCanvas({
  threadId,
  initialCurrentRun,
}: ConversationCanvasProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [runId, setRunId] = useState<string | null>(
    initialCurrentRun?.runId ?? null,
  );
  const [runStatus, setRunStatus] = useState<string | null>(
    initialCurrentRun?.status ?? null,
  );
  const [optimistic, setOptimistic] = useState<string | null>(null);

  // Thread rename state
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  // Thread + agent identity for header
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

  // Empty state — agent identity
  const { data: identity } = useQuery({
    queryKey: ["identity", thread?.agentId],
    queryFn: () => api.getIdentity(thread!.agentId),
    enabled: !!thread?.agentId,
    staleTime: 120_000,
  });

  const { data: currentRun } = useQuery({
    queryKey: ["currentRun", threadId],
    queryFn: () => api.getCurrentRun(threadId),
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (currentRun && !runId) {
      setRunId(currentRun.runId);
      setRunStatus(currentRun.status);
    }
  }, [currentRun, runId]);

  const {
    items,
    isStreamingDone,
    liveStatus,
    liveMessages,
    historyLoading,
  } = useTimeline(threadId, runId, optimistic);

  // M13: Delta stream for real-time text rendering
  const delta = useDeltaStream(runId);

  // Align delta AST when /events delivers the latest assistant message.
  // Only finalize the LAST assistant message (it's the one being streamed).
  useEffect(() => {
    const lastAssistant = liveMessages.findLast(
      (r) =>
        r.event.type === "message" &&
        (r.event.payload as { role?: string })?.role === "assistant",
    );
    if (!lastAssistant) return;
    const payload = lastAssistant.event.payload as {
      role: string;
      content: string | Array<{ type: string; text?: string }>;
    };
    const blocks = Array.isArray(payload.content)
      ? payload.content
      : [{ type: "text", text: payload.content }];
    if (blocks.length > 0) {
      delta.finalize(blocks);
    }
  }, [liveMessages.length, delta.finalize]);

  // Last live item seq — used to identify which assistant message is actively
  // streaming (vs. completed history items that should render as static MessageBubble).
  const lastLiveSeq = useMemo(() => {
    const liveOnes = items.filter((it) => it.seq !== undefined);
    if (liveOnes.length === 0) return undefined;
    const last = liveOnes[liveOnes.length - 1]!;
    return last.role === "assistant" && !isStreamingDone ? last.seq : undefined;
  }, [items, isStreamingDone]);

  // Count heavy items for the anchor indicator only (not for rendering order)
  const heavyCount = useMemo(
    () => items.filter((it) => routeItem(it) === "main").length,
    [items],
  );

  // Clear optimistic only when user echo appears in live stream
  useEffect(() => {
    if (!optimistic) return;
    const hasUserEcho = liveMessages.some(
      (r) =>
        r.event.type === "message" &&
        (r.event.payload as { role?: string })?.role === "user",
    );
    if (hasUserEcho) setOptimistic(null);
  }, [liveMessages, optimistic]);

  const interruptRecord = liveMessages
    .filter((r) => r.event.type === "interrupted")
    .pop();
  const pendingInterrupt = interruptRecord?.event.payload as
    | { pendingTool?: { id: string; name: string; input: unknown } }
    | undefined;

  const startRun = useMutation({
    mutationFn: (input: string) => api.startRun(threadId, input),
    onSuccess: (data) => {
      setRunId(data.runId);
      setRunStatus("running");
      queryClient.invalidateQueries({ queryKey: ["currentRun", threadId] });
    },
    onError: () => {
      setRunStatus("error");
    },
  });

  const resumeRun = useMutation({
    mutationFn: ({
      approved,
      message,
    }: {
      approved: boolean;
      message?: string;
    }) => api.resumeRun(runId!, approved, message),
    onSuccess: () => setRunStatus("running"),
  });

  const cancelRun = useMutation({
    mutationFn: () => api.cancelRun(runId!),
    onSuccess: () => setRunStatus("aborted"),
  });

  const renameThread = useMutation({
    mutationFn: (title: string) => api.updateThread(threadId, { title }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["thread", threadId] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
    },
  });

  const deleteThread = useMutation({
    mutationFn: () => api.deleteThread(threadId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      router.replace(thread?.agentId ? `/agents/${thread.agentId}` : "/agents");
    },
  });

  useEffect(() => {
    if (liveStatus === "done") {
      setRunStatus("succeeded");
      setOptimistic(null);
    }
  }, [liveStatus]);

  const isBusy =
    runStatus === "running" ||
    liveStatus === "streaming" ||
    liveStatus === "connecting";

  const label = computeStatus(runId, runStatus, liveStatus);

  // Scroll-to-bottom on new messages (must be before handleSend)
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, []);

  // Scroll-to-bottom floating pill
  const [showScrollPill, setShowScrollPill] = useState(false);
  const busyRef = useRef(isBusy);
  busyRef.current = isBusy;
  const onScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setShowScrollPill(
      scrollHeight - scrollTop - clientHeight > 300 && busyRef.current,
    );
  }, []);

  const handleSend = useCallback(
    (message: string) => {
      setOptimistic(message);
      // Set running immediately so UI locks (prevent double-send), don't wait for onSuccess
      setRunStatus("running");
      startRun.mutate(message);
      setTimeout(() => scrollToBottom(), 50);
    },
    [startRun.mutate, scrollToBottom],
  );

  // Retry last message on error
  const lastUserMessage = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.role === "user") return extractText(items[i]!.content);
    }
    return null;
  }, [items]);
  const handleRetry = useCallback(() => {
    if (lastUserMessage) {
      startRun.mutate(lastUserMessage);
      setRunStatus("running");
    }
  }, [lastUserMessage, startRun.mutate]);

  // Auto-scroll when interrupt appears
  useEffect(() => {
    if (pendingInterrupt) scrollToBottom();
  }, [pendingInterrupt, scrollToBottom]);
  const handleApprove = useCallback(
    (message?: string) => resumeRun.mutate({ approved: true, message }),
    [resumeRun.mutate],
  );
  const handleDeny = useCallback(
    (message?: string) => resumeRun.mutate({ approved: false, message }),
    [resumeRun.mutate],
  );

  // Auto-scroll when new items arrive (instant — no jank during streaming)
  const prevItemCount = useRef(items.length);
  useEffect(() => {
    if (items.length > prevItemCount.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevItemCount.current = items.length;
  }, [items.length]);

  // On initial load (history loaded), scroll to bottom
  const didInitialScroll = useRef(false);
  useEffect(() => {
    if (!historyLoading && !didInitialScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      didInitialScroll.current = true;
    }
  }, [historyLoading]);

  return (
    <div className="h-full flex flex-col bg-[var(--canvas)]">
      {/* Ambient header — breadcrumb + thread title + status */}
      <div className="shrink-0 border-b border-[var(--hairline)] px-6 py-3">
        {/* Row 1: breadcrumb + status */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <Link
              href="/agents"
              className="text-[10px] text-[var(--mute)] hover:text-[var(--body)] transition-colors shrink-0"
            >
              Agents
            </Link>
            {agent && (
              <>
                <span className="text-[var(--hairline)]">/</span>
                <Link
                  href={`/agents/${agent.id}`}
                  className="text-[10px] text-[var(--mute)] hover:text-[var(--body)] transition-colors truncate"
                >
                  {agent.name}
                </Link>
              </>
            )}
            <span className="text-[var(--hairline)]">/</span>
            {editingTitle ? (
              <input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    renameThread.mutate(titleDraft);
                    setEditingTitle(false);
                  }
                  if (e.key === "Escape") setEditingTitle(false);
                }}
                onBlur={() => {
                  if (titleDraft.trim()) renameThread.mutate(titleDraft);
                  setEditingTitle(false);
                }}
                autoFocus
                className="text-[10px] bg-[var(--canvas-soft)] border border-[var(--primary)] rounded px-1.5 py-0.5 text-[var(--ink)] outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setTitleDraft(thread?.title ?? "");
                  setEditingTitle(true);
                }}
                className="text-[10px] text-[var(--body)] hover:text-[var(--ink)] transition-colors truncate"
                title="Click to rename"
              >
                {thread?.title || "Untitled"}
              </button>
            )}
          </div>

          <div className="flex items-center gap-3 shrink-0 ml-4">
            {label && (
              <>
                <span
                  className={`w-1.5 h-1.5 rounded-full transition-colors duration-500 ${
                    isBusy ? "animate-dot-pulse" : ""
                  }`}
                  style={{
                    backgroundColor: isBusy ? "var(--primary)" : "var(--mute)",
                  }}
                />
                <span
                  className="text-xs tracking-[0.15em] uppercase font-semibold"
                  style={{
                    color: isBusy ? "var(--primary)" : "var(--mute)",
                  }}
                >
                  {label}
                </span>
              </>
            )}
            {!label && (
              <span className="text-xs text-[var(--mute)]">Idle</span>
            )}
            {runId && (runStatus === "running" || cancelRun.isPending) && (
              <button
                type="button"
                onClick={() => cancelRun.mutate()}
                disabled={cancelRun.isPending}
                className="text-[10px] uppercase tracking-[0.15em] text-[var(--body)] hover:text-[var(--ink)] disabled:opacity-40 transition-colors"
              >
                {cancelRun.isPending ? "Cancelling…" : "Cancel"}
              </button>
            )}
          </div>
        </div>

        {/* Row 2: agent name + model + thread actions */}
        <div className="flex items-center gap-2 mt-2">
          {agent && (
            <span className="text-sm font-medium text-[var(--ink-strong)]">
              {agent.name}
            </span>
          )}
          {agent && (
            <span className="text-[10px] text-[var(--mute)] px-1.5 py-0.5 border border-[var(--hairline)] rounded font-[family-name:var(--font-mono)]">
              {agent.modelName}
            </span>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => {
              if (confirm("Delete this thread?")) deleteThread.mutate();
            }}
            disabled={deleteThread.isPending}
            className="text-[10px] text-[var(--mute)] hover:text-[var(--body)] disabled:opacity-40 transition-colors"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Error alerts */}
      {liveMessages
        .filter((r) => r.event.type === "error")
        .map((r) => (
          <div
            key={r.seq ?? (r.event.payload as { message?: string })?.message?.slice(0, 20)}
            className="border-b border-[var(--hairline)] bg-[var(--canvas-soft)] px-6 py-2 shrink-0 flex items-center justify-between"
          >
            <div className="flex items-center gap-2">
              <span className="w-1 h-4 bg-[var(--primary)]/60 shrink-0 rounded-full" />
              <p className="text-xs text-[var(--ink)]">
                {(r.event.payload as { message?: string })?.message ??
                  "An error occurred"}
              </p>
            </div>
            {lastUserMessage && (
              <button
                type="button"
                onClick={handleRetry}
                disabled={startRun.isPending}
                className="text-xs text-[var(--primary)] hover:text-[var(--primary-soft)] disabled:opacity-40 transition-colors shrink-0 ml-4"
              >
                Retry
              </button>
            )}
          </div>
        ))}

      {/* Main scrollable area: unified timeline (chronological order) */}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto relative">
        <div className="mx-auto" style={{ maxWidth: "72ch", padding: "0 1.5rem" }}>
          {/* Heavy count indicator (informational only, no segregation) */}
          {heavyCount > 0 && (
            <div className="pt-4 pb-1">
              <p className="text-[10px] tracking-[0.1em] uppercase text-[var(--primary)]/60 font-[family-name:var(--font-sans)] font-semibold">
                {heavyCount} heavy block{heavyCount > 1 ? "s" : ""}
              </p>
            </div>
          )}

          {/* Thinking / tool-status indicator */}
          {isBusy && !historyLoading && (() => {
            // Detect unpaired tool_use blocks in the last live item
            const lastItem = items[items.length - 1];
            const liveTools: string[] = [];
            if (lastItem && Array.isArray(lastItem.content)) {
              const blocks = lastItem.content as Array<{ type?: string; name?: string; id?: string }>;
              const resultIds = new Set(
                blocks.filter((b) => b.type === "tool_result" && b.id).map((b) => b.id),
              );
              for (const b of blocks) {
                if (b.type === "tool_use" && b.name && !resultIds.has(b.id)) {
                  liveTools.push(b.name);
                }
              }
            }
            const showThinking = delta.connection !== "connected" && items.length === 0;
            const showTools = liveTools.length > 0;

            if (!showThinking && !showTools) return null;
            return (
              <div className="flex items-center gap-3 py-8">
                <span className="w-1.5 h-1.5 rounded-full shrink-0 animate-dot-pulse bg-[var(--primary)]" />
                <span className="text-sm text-[var(--mute)]">
                  {showTools
                    ? `Running ${liveTools.join(", ")}…`
                    : "Agent is working…"}
                </span>
              </div>
            );
          })()}

          {/* Conversation timeline */}
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
          ) : items.length === 0 && delta.connection !== "connected" ? (
            /* Empty state — agent identity card */
            <div className="flex flex-col items-start justify-center py-24">
              {agent && (
                <h1
                  className="font-[family-name:var(--font-sans)] text-2xl font-normal text-[var(--ink-strong)] mb-3"
                  style={{ letterSpacing: "-0.65px" }}
                >
                  {agent.name}
                </h1>
              )}
              {identity?.soul && (
                <p className="text-sm text-[var(--body)] mb-4 max-w-lg leading-relaxed">
                  {identity.soul.slice(0, 200)}
                  {identity.soul.length > 200 ? "…" : ""}
                </p>
              )}
              <p className="text-sm text-[var(--mute)] mb-6">
                Send a message to begin working with this agent.
              </p>
              <p className="font-[family-name:var(--font-mono)] text-[13px] text-[var(--primary)]">
                &#x25B8; type to start
              </p>
            </div>
          ) : (
            <div className="py-4">
              <Timeline
                items={items}
                lastLiveSeq={lastLiveSeq}
                isStreamingDone={isStreamingDone}
                delta={delta}
              />
            </div>
          )}

        </div>
      </div>

      {/* Scroll-to-bottom floating pill */}
      {showScrollPill && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
          <button
            type="button"
            onClick={() => scrollToBottom()}
            className="bg-[var(--canvas-soft)] border border-[var(--hairline)] rounded-full px-4 py-1.5 text-xs text-[var(--primary)] hover:border-[var(--primary)] transition-colors shadow-lg"
          >
            ↓ New messages
          </button>
        </div>
      )}

      {/* Interrupt approval */}
      {pendingInterrupt?.pendingTool && (
        <div className="shrink-0 border-t border-[var(--hairline)]">
          <ToolApprovalCard
            tool={pendingInterrupt.pendingTool}
            onApprove={handleApprove}
            onDeny={handleDeny}
            disabled={resumeRun.isPending}
          />
        </div>
      )}

      {/* Composer — pinned to bottom */}
      <div className="shrink-0 border-t border-[var(--hairline)]">
        <Composer onSend={handleSend} disabled={isBusy} />
      </div>
    </div>
  );
}
