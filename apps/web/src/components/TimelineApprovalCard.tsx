"use client";

import { Button } from "@/components/ui/button";
import type { TransientApproval } from "@/lib/transient-reducer";

interface TimelineApprovalCardProps {
  runId: string;
  approval: TransientApproval;
  onResolveApproval?: (runId: string, callId: string, decision: "allow" | "deny") => void;
}

export function TimelineApprovalCard({
  runId,
  approval,
  onResolveApproval,
}: TimelineApprovalCardProps) {
  return (
    <div
      data-testid="approval-card"
      className="my-1 rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1.5"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs text-amber-600">
          ⏸ approve <b>{approval.toolName}</b>
          {approval.reason ? ` — ${approval.reason}` : ""}
        </span>
        {typeof approval.sandboxed === "boolean" && (
          <span
            data-testid={approval.sandboxed ? "approval-sandboxed" : "approval-unsandboxed"}
            className={`rounded px-1 py-0.5 font-mono text-[10px] ${
              approval.sandboxed ? "bg-sky-500/10 text-sky-600" : "bg-red-500/10 text-red-600"
            }`}
            title={
              approval.sandboxed
                ? "bash runs inside the OS sandbox (bwrap/Seatbelt): workspace-only writes, no network. Still requires your approval."
                : "bash runs WITHOUT an OS sandbox — it can read the filesystem and reach the network."
            }
          >
            {approval.sandboxed ? "OS sandbox" : "no OS sandbox"}
          </span>
        )}
        <span className="flex-1" />
        <Button
          type="button"
          size="sm"
          data-testid="approval-allow"
          className="h-6 bg-emerald-600 px-2 text-xs text-white hover:bg-emerald-500"
          onClick={() => onResolveApproval?.(runId, approval.callId, "allow")}
        >
          Allow
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid="approval-deny"
          className="h-6 bg-red-600 px-2 text-xs text-white hover:bg-red-500"
          onClick={() => onResolveApproval?.(runId, approval.callId, "deny")}
        >
          Deny
        </Button>
      </div>
      {approval.error && (
        <p data-testid="approval-error" className="mt-1 text-xs text-red-600">
          {approval.error}
        </p>
      )}
    </div>
  );
}
