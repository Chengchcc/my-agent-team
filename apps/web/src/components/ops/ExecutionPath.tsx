"use client";

import type { RunOpsDetail } from "@/lib/api";

const STAGES = [
  { key: "scheduled", label: "Scheduled", opsKind: "attempt_started" },
  { key: "start_sent", label: "Start sent", opsKind: "attempt_started" },
  { key: "runner_heartbeat", label: "Runner heartbeat", opsKind: "heartbeat" },
  { key: "eventlog_append", label: "Event log", opsKind: "event" },
  { key: "surface_projection", label: "Surface projection", opsKind: "surface" },
  { key: "run_done", label: "Run done", opsKind: "run_done_received" },
  { key: "run_finalized", label: "Run finalized", opsKind: "run_finalized_sent" },
] as const;

type StageStatus = "completed" | "pending" | "not_instrumented";

function stageStatus(
  stage: (typeof STAGES)[number],
  detail: RunOpsDetail,
): StageStatus {
  const hasOps = detail.ops.some((o) => {
    if (stage.key === "start_sent" || stage.key === "scheduled") {
      return o.kind === "attempt_started";
    }
    if (stage.key === "runner_heartbeat") {
      return true;
    }
    if (stage.key === "eventlog_append") {
      return detail.eventLog.lastEventType != null;
    }
    if (stage.key === "run_done") {
      return o.kind === "run_done_received";
    }
    if (stage.key === "run_finalized") {
      return o.kind === "run_finalized_sent";
    }
    return o.kind.includes(stage.key);
  });

  if (hasOps) return "completed";

  if (detail.run.status !== "running") {
    return stage.key === "surface_projection" ? "not_instrumented" : "completed";
  }

  return "pending";
}

const statusClass: Record<StageStatus, string> = {
  completed: "text-primary",
  pending: "text-muted-foreground",
  not_instrumented: "text-muted-foreground/40",
};

export function ExecutionPath({ detail }: { detail: RunOpsDetail }) {
  return (
    <div className="space-y-1">
      {STAGES.map((stage) => {
        const status = stageStatus(stage, detail);
        const icon = status === "completed" ? "●" : status === "pending" ? "○" : "◇";
        return (
          <div key={stage.key} className="flex items-center gap-2 text-xs">
            <span className={statusClass[status]}>{icon}</span>
            <span className={status === "pending" ? "text-muted-foreground" : "text-foreground"}>
              {stage.label}
            </span>
            {status === "not_instrumented" && (
              <span className="text-muted-foreground/40 italic">not instrumented</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
