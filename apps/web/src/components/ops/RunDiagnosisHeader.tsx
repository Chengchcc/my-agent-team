"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RunOpsDetail } from "@/lib/api";
import { diagnoseRun } from "@/lib/ops-diagnosis";
import { CopyButton } from "./CopyButton";

const diagnosisLabel: Record<string, string> = {
  running: "Running",
  heartbeat_stale: "Heartbeat stale",
  detached_waiting_reaper: "Detached placeholder",
  surface_projection_failed: "Surface projection failed",
  terminal: "Terminal",
};

const ownerLabel: Record<string, string> = {
  none: "—",
  runner: "Runner",
  backend_runner_link: "Runner connection",
  surface: "Surface",
  unknown: "Unknown",
};

const diagnosisBadgeVariant: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  running: "default",
  heartbeat_stale: "outline",
  detached_waiting_reaper: "secondary",
  surface_projection_failed: "destructive",
  terminal: "secondary",
};

export function RunDiagnosisHeader({ detail }: { detail: RunOpsDetail }) {
  const diagnosis = diagnoseRun(detail);
  const [showEvidence, setShowEvidence] = useState(false);

  const evidence: string[] = [];
  if (detail.eventLog.lastEventType)
    evidence.push(`lastEventType=${detail.eventLog.lastEventType}`);
  const lastOps = detail.ops.at(-1);
  if (lastOps) evidence.push(`lastOpsKind=${lastOps.kind}`);

  return (
    <div className="rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="font-mono text-xs text-foreground">{detail.run.runId}</span>
        <CopyButton text={detail.run.runId} label="run ID" />

        <Badge variant={diagnosisBadgeVariant[diagnosis.kind]}>{detail.run.status}</Badge>

        <span className="text-muted-foreground">Diagnosis:</span>
        <span className="font-medium text-foreground">{diagnosisLabel[diagnosis.kind]}</span>

        <span className="text-muted-foreground">Owner:</span>
        <span className="text-foreground">{ownerLabel[diagnosis.owner]}</span>

        {detail.run.traceId && (
          <span className="font-mono text-xs text-muted-foreground">
            trace: {detail.run.traceId.slice(0, 16)}…
          </span>
        )}

        <span className="text-muted-foreground">
          Duration:{" "}
          {detail.run.endedAt
            ? `${Math.floor((detail.run.endedAt - detail.run.startedAt) / 1000)}s`
            : `${Math.floor((Date.now() - detail.run.startedAt) / 1000)}s (running)`}
        </span>

        {evidence.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowEvidence(!showEvidence)}
            className="text-xs h-auto py-0"
          >
            {showEvidence ? "▲ hide evidence" : "▼ why"}
          </Button>
        )}
      </div>

      {showEvidence && evidence.length > 0 && (
        <div className="mt-2 pt-2 border-t text-xs text-muted-foreground space-y-0.5">
          {evidence.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}
    </div>
  );
}
