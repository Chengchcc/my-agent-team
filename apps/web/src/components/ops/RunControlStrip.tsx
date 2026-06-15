"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { RunOpsDetail } from "@/lib/api";
import { diagnoseRun } from "@/lib/ops-diagnosis";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

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
    onSuccess: (result) => {
      if (result.ok) {
        toast.success(result.state === "abort_sent" ? "Cancel signal sent" : "Run already finished");
      } else {
        toast.error("Cancel failed", { description: "Run not found" });
      }
      qc.invalidateQueries({ queryKey: ["ops", "runDetail", runId] });
      qc.invalidateQueries({ queryKey: ["ops", "runs"] });
      qc.invalidateQueries({ queryKey: ["ops", "agentRuntime"] });
    },
    onError: (err) => {
      toast.error("Cancel failed", { description: err instanceof Error ? err.message : "Unknown error" });
    },
  });

  const recoverMut = useMutation({
    mutationFn: () => api.opsRecoverRun(runId),
    onSuccess: (result) => {
      if (result.state === "reattached") {
        toast.success("Run recovered — daemon reattached");
      } else if (result.state === "marked_interrupted") {
        toast.success("Run marked as interrupted (heartbeat timeout)");
      } else if (result.state === "already_terminal") {
        toast("Run already in terminal state");
      } else {
        toast("Waiting for heartbeat to complete");
      }
      qc.invalidateQueries({ queryKey: ["ops", "runDetail", runId] });
      qc.invalidateQueries({ queryKey: ["ops", "runs"] });
      qc.invalidateQueries({ queryKey: ["ops", "agentRuntime"] });
    },
    onError: (err) => {
      toast.error("Recover failed", { description: err instanceof Error ? err.message : "Unknown error" });
    },
  });

  const isTerminal = diagnosis.kind === "terminal";
  const isDetached = diagnosis.kind === "detached_waiting_reaper";

  return (
    <div className="flex items-center gap-2">
      {!isTerminal && !isDetached && (
        <Button
          variant="outline"
          size="sm"
          disabled={cancelMut.isPending}
          onClick={() => cancelMut.mutate()}
        >
          {cancelMut.isPending ? "Cancelling…" : "Cancel run"}
        </Button>
      )}

      {isDetached && (
        <Button
          size="sm"
          disabled={recoverMut.isPending}
          onClick={() => recoverMut.mutate()}
        >
          {recoverMut.isPending ? "Recovering…" : "Recover"}
        </Button>
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
    </div>
  );
}
