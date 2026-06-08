"use client";

import { useState, useCallback, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useTimeline } from "@/hooks/useTimeline";
import { Timeline } from "./Timeline";
import { Composer } from "./Composer";
import { ToolApprovalCard } from "./ToolApprovalCard";
import Link from "next/link";

interface ChatWorkspaceProps {
  threadId: string;
  initialCurrentRun: { runId: string; status: string } | null;
}

export function ChatWorkspace({
  threadId,
  initialCurrentRun,
}: ChatWorkspaceProps) {
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
    liveAssistantIndex,
    isStreamingDone,
    liveStatus,
    liveMessages,
    historyLoading,
  } = useTimeline(threadId, runId, optimistic);

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
    if (runStatus === "error" || liveStatus === "error") return "bg-[var(--rust)]";
    return "bg-[var(--border-color)]";
  })();

  return (
    <div className="flex flex-col h-screen bg-[var(--cream)]">
      {/* Header bar */}
      <div className="border-b border-[var(--border-color)] px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            href="/agents"
            className="font-[family-name:var(--font-mono)] text-[10px] tracking-[0.15em] uppercase text-[var(--warm-gray-dark)] hover:text-[var(--charcoal)] transition-colors"
          >
            ← Agents
          </Link>
          <div className="w-px h-4 bg-[var(--border-color)]" />
          <h1 className="font-[family-name:var(--font-heading)] text-base font-medium text-[var(--charcoal)]">
            Thread
          </h1>
        </div>

        <div className="flex items-center gap-3">
          {/* Status */}
          <div className="flex items-center gap-2">
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
          </div>

          {runId && runStatus === "running" && (
            <button
              type="button"
              onClick={() => cancelRun.mutate()}
              className="font-[family-name:var(--font-mono)] text-[9px] tracking-[0.15em] uppercase
                         text-[var(--rust)] hover:underline"
            >
              Cancel Run
            </button>
          )}
        </div>
      </div>

      {/* Error alerts */}
      {liveMessages
        .filter((r) => r.event.type === "error")
        .map((r, i) => (
          <div
            key={i}
            className="border-b border-[var(--rust)]/30 bg-[var(--rust)]/5 px-6 py-3"
          >
            <p className="font-[family-name:var(--font-mono)] text-xs text-[var(--rust)]">
              {(r.event.payload as { message?: string })?.message ??
                "An error occurred"}
            </p>
          </div>
        ))}

      {/* Timeline */}
      {historyLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="space-y-4 w-full max-w-2xl px-8">
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-pulse">
                <div className="h-3 w-12 bg-[var(--warm-gray)] mb-3" />
                <div className="h-4 w-3/4 bg-[var(--warm-gray)]" />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <Timeline
          items={items}
          liveAssistantIndex={liveAssistantIndex}
          isStreamingDone={isStreamingDone}
        />
      )}

      {/* Interrupt approval */}
      {pendingInterrupt?.pendingTool && (
        <ToolApprovalCard
          tool={pendingInterrupt.pendingTool}
          onApprove={handleApprove}
          onDeny={handleDeny}
          disabled={resumeRun.isPending}
        />
      )}

      {/* Composer */}
      <Composer onSend={handleSend} disabled={isBusy} />
    </div>
  );
}
