"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { RunOpsDetail } from "@/lib/api";
import { diagnoseRun } from "@/lib/ops-diagnosis";

export function RunControlStrip({
  detail,
  heartbeatTimeoutMs,
}: {
  detail: RunOpsDetail;
  heartbeatTimeoutMs: number;
}) {
  const qc = useQueryClient();
  const diagnosis = diagnoseRun(detail, heartbeatTimeoutMs);
  const runId = detail.run.runId;
  const agentId = detail.run.agentId;

  const cancelMut = useMutation({
    mutationFn: () => api.opsCancelRun(runId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ops", "runDetail", runId] });
      qc.invalidateQueries({ queryKey: ["ops", "runs"] });
      qc.invalidateQueries({ queryKey: ["ops", "agentRuntime", agentId] });
    },
  });

  const recoverMut = useMutation({
    mutationFn: () => api.opsRecoverRun(runId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ops", "runDetail", runId] });
      qc.invalidateQueries({ queryKey: ["ops", "runs"] });
      qc.invalidateQueries({ queryKey: ["ops", "agentRuntime", agentId] });
    },
  });

  const isTerminal = diagnosis.kind === "terminal";
  const isDetached = diagnosis.kind === "detached_waiting_reaper";

  return (
    <div className="flex items-center gap-2">
      {!isTerminal && !isDetached && (
        <button
          type="button"
          disabled={cancelMut.isPending}
          onClick={() => cancelMut.mutate()}
          className="px-3 py-1.5 text-xs font-medium rounded-md border text-foreground hover:bg-muted disabled:opacity-50 transition-colors"
        >
          {cancelMut.isPending ? "Cancelling…" : "Cancel run"}
        </button>
      )}

      {isDetached && (
        <button
          type="button"
          disabled={recoverMut.isPending}
          onClick={() => recoverMut.mutate()}
          className="px-3 py-1.5 text-xs font-medium rounded-md border border-primary text-primary hover:bg-primary hover:text-primary-foreground disabled:opacity-50 transition-colors"
        >
          {recoverMut.isPending ? "Recovering…" : "Recover"}
        </button>
      )}

      {isDetached && (
        <span className="text-xs text-muted-foreground">
          Wait for reaper ({Math.floor(heartbeatTimeoutMs / 1000)}s timeout)
        </span>
      )}

      {isTerminal && (
        <span className="text-xs text-muted-foreground">
          Final: {detail.run.status}
        </span>
      )}

      {cancelMut.isError && (
        <span className="text-xs text-red-400">
          Cancel failed: {cancelMut.error instanceof Error ? cancelMut.error.message : "Unknown"}
        </span>
      )}
      {recoverMut.isError && (
        <span className="text-xs text-red-400">
          Recover failed: {recoverMut.error instanceof Error ? recoverMut.error.message : "Unknown"}
        </span>
      )}
    </div>
  );
}
