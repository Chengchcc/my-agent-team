"use client";

import { useState, useCallback, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useTimeline } from "@/hooks/useTimeline";
import { Timeline } from "./Timeline";
import { Composer } from "./Composer";
import { RunStatusBadge } from "./RunStatusBadge";
import { ToolApprovalCard } from "./ToolApprovalCard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

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

  // D12: re-fetch current run on mount (handles refresh)
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
  } = useTimeline(threadId, runId);

  // Find pending interrupt from live events
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
      queryClient.invalidateQueries({
        queryKey: ["currentRun", threadId],
      });
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
    onSuccess: () => {
      setRunStatus("running");
    },
  });

  const cancelRun = useMutation({
    mutationFn: () => api.cancelRun(runId!),
    onSuccess: () => {
      setRunStatus("aborted");
    },
  });

  // Run done → sync status
  useEffect(() => {
    if (liveStatus === "done") {
      setRunStatus("succeeded");
      queryClient.invalidateQueries({
        queryKey: ["history", threadId],
      });
    }
  }, [liveStatus, threadId, queryClient]);

  const handleSend = useCallback(
    (message: string) => {
      startRun.mutate(message);
    },
    [startRun],
  );

  const handleApprove = useCallback(
    (message?: string) => {
      resumeRun.mutate({ approved: true, message });
    },
    [resumeRun],
  );

  const handleDeny = useCallback(
    (message?: string) => {
      resumeRun.mutate({ approved: false, message });
    },
    [resumeRun],
  );

  const isBusy =
    runStatus === "running" ||
    liveStatus === "streaming" ||
    liveStatus === "connecting";

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="border-b px-4 py-3 flex items-center justify-between bg-background">
        <h1 className="font-semibold text-lg">Thread</h1>
        <div className="flex items-center gap-2">
          {runId && (
            <RunStatusBadge status={runStatus ?? liveStatus} />
          )}
          {runId && runStatus === "running" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => cancelRun.mutate()}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>

      {/* Error alerts */}
      {liveMessages
        .filter((r) => r.event.type === "error")
        .map((r, i) => (
          <Alert key={i} variant="destructive" className="rounded-none">
            <AlertDescription>
              {(r.event.payload as { error?: string })?.error ??
                "An error occurred"}
            </AlertDescription>
          </Alert>
        ))}

      {/* Timeline */}
      {historyLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="space-y-4 w-full max-w-2xl px-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-3/4" />
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

      {/* Interrupt approval card */}
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
