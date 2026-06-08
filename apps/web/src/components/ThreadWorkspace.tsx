"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useTimeline } from "@/hooks/useTimeline";
import { Timeline } from "./Timeline";
import { Composer } from "./Composer";
import { ToolApprovalCard } from "./ToolApprovalCard";
import { MainCanvas } from "./MainCanvas";
import { MessageBubble } from "./MessageBubble";
import { useShell } from "./ShellProvider";
import { AgentDrawer } from "./AgentDrawer";
import { routeItem, extractText } from "@/lib/timeline";

interface ThreadWorkspaceProps {
  threadId: string;
  initialCurrentRun: { runId: string; status: string } | null;
}

export function ThreadWorkspace({
  threadId,
  initialCurrentRun,
}: ThreadWorkspaceProps) {
  const queryClient = useQueryClient();
  const [runId, setRunId] = useState<string | null>(
    initialCurrentRun?.runId ?? null,
  );
  const [runStatus, setRunStatus] = useState<string | null>(
    initialCurrentRun?.status ?? null,
  );
  const [optimistic, setOptimistic] = useState<string | null>(null);

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

  // Split items into drawer (conversation stream) and main (heavy output)
  const { drawerItems, mainItems } = useMemo(() => {
    const d = items.filter((it) => routeItem(it) === "drawer");
    const m = items.filter((it) => routeItem(it) === "main");
    return { drawerItems: d, mainItems: m };
  }, [items]);

  // Find the last assistant index within drawer items (for streaming indicator)
  const drawerAssistantIdx = useMemo(() => {
    for (let i = drawerItems.length - 1; i >= 0; i--) {
      if (drawerItems[i]!.role === "assistant") return i;
    }
    return -1;
  }, [drawerItems]);

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

  useEffect(() => {
    if (liveStatus === "done") {
      setRunStatus("succeeded");
      setOptimistic(null);
    }
  }, [liveStatus]);

  const handleSend = useCallback(
    (message: string) => {
      setOptimistic(message);
      startRun.mutate(message);
    },
    [startRun],
  );
  const handleApprove = useCallback(
    (message?: string) => resumeRun.mutate({ approved: true, message }),
    [resumeRun],
  );
  const handleDeny = useCallback(
    (message?: string) => resumeRun.mutate({ approved: false, message }),
    [resumeRun],
  );

  const isBusy =
    runStatus === "running" ||
    liveStatus === "streaming" ||
    liveStatus === "connecting";

  const statusLabel = (() => {
    if (!runId) return "Idle";
    if (liveStatus === "connecting") return "Connecting";
    if (liveStatus === "streaming" || runStatus === "running") return "Running";
    if (runStatus === "interrupted") return "Awaiting Approval";
    if (runStatus === "succeeded" || liveStatus === "done") return "Complete";
    if (runStatus === "aborted") return "Aborted";
    if (runStatus === "error" || liveStatus === "error") return "Error";
    return runStatus ?? "Idle";
  })();

  const statusDotClass = (() => {
    if (isBusy) return "bg-[var(--brass)]";
    if (runStatus === "interrupted") return "bg-[var(--brass-light)]";
    if (
      runStatus === "error" ||
      liveStatus === "error"
    )
      return "bg-[var(--rust)]";
    return "bg-[var(--border-color)]";
  })();

  // Build status line for MainCanvas progress mirror
  const statusLine = isBusy
    ? { text: statusLabel, badge: runId ? `Thread ${threadId.slice(0, 6)}` : undefined }
    : null;

  // ── Drawer content ──
  const drawerContent = (
    <AgentDrawer>
      <div className="flex flex-col h-full">
        {/* Status bar inside drawer */}
        <div className="px-4 py-2 border-b border-[var(--border-color)] flex items-center gap-2 shrink-0">
          <span
            className={`w-1.5 h-1.5 rounded-full ${statusDotClass} transition-colors duration-500`}
            style={
              isBusy
                ? { animation: "dot-pulse 1.5s ease-in-out infinite" }
                : undefined
            }
          />
          <span className="font-[family-name:var(--font-mono)] text-[9px] tracking-[0.15em] uppercase text-[var(--warm-gray-dark)]">
            {statusLabel}
          </span>
          {runId && runStatus === "running" && (
            <button
              type="button"
              onClick={() => cancelRun.mutate()}
              className="ml-auto font-[family-name:var(--font-mono)] text-[9px] tracking-[0.15em] uppercase text-[var(--rust)] hover:underline"
            >
              Cancel
            </button>
          )}
        </div>

        {/* Error alerts */}
        {liveMessages
          .filter((r) => r.event.type === "error")
          .map((r, i) => (
            <div
              key={i}
              className="border-b border-[var(--rust)]/30 bg-[var(--rust)]/5 px-4 py-2 shrink-0"
            >
              <p className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--rust)]">
                {(r.event.payload as { message?: string })?.message ??
                  "An error occurred"}
              </p>
            </div>
          ))}

        {/* Timeline (conversation) */}
        {historyLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="space-y-4 w-full px-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="animate-pulse">
                  <div className="h-2 w-8 bg-[var(--warm-gray)] mb-2" />
                  <div className="h-3 w-3/4 bg-[var(--warm-gray)]" />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            <Timeline
              items={drawerItems}
              liveAssistantIndex={drawerAssistantIdx}
              isStreamingDone={isStreamingDone}
            />
          </div>
        )}

        {/* Interrupt approval */}
        {pendingInterrupt?.pendingTool && (
          <div className="shrink-0">
            <ToolApprovalCard
              tool={pendingInterrupt.pendingTool}
              onApprove={handleApprove}
              onDeny={handleDeny}
              disabled={resumeRun.isPending}
            />
          </div>
        )}

        {/* Composer */}
        <div className="shrink-0">
          <Composer onSend={handleSend} disabled={isBusy} />
        </div>
      </div>
    </AgentDrawer>
  );

  // Register drawer content via shell context
  const { setDrawerContent } = useShell();
  useEffect(() => {
    setDrawerContent(drawerContent);
    return () => setDrawerContent(null);
  }, [drawerContent, setDrawerContent]);

  return (
    <MainCanvas
      statusLine={statusLine}
      emptyState={
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 mb-6 rounded-full bg-[var(--warm-gray)] flex items-center justify-center">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              className="text-[var(--warm-gray-dark)]"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </div>
          <p className="font-[family-name:var(--font-heading)] text-sm text-[var(--warm-gray-dark)] mb-2">
            Output will appear here
          </p>
          <p className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--warm-gray-dark)] max-w-xs">
            Structured outputs — code, tables, documents — surface in this area
            while you monitor the process on the right.
          </p>
        </div>
      }
    >
      {mainItems.length > 0 && (
        <div className="space-y-4">
          {mainItems.map((item, i) => {
            const text = extractText(item.content);
            const key = item.seq ?? `main-${i}`;
            if (!text) return null;
            return (
              <div key={key} className="animate-fade-in">
                <MessageBubble role={item.role} content={text} />
              </div>
            );
          })}
        </div>
      )}
    </MainCanvas>
  );
}
