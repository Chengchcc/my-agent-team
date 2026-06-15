"use client";

import type { RunOpsDetail } from "@/lib/api";
import { useState } from "react";
import { Button } from "@/components/ui/button";

function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function TimelineRow({ o }: { o: RunOpsDetail["ops"][number] }) {
  const [open, setOpen] = useState(false);
  const hasPayload = Object.keys(o.payload).length > 0;

  return (
    <div className="flex items-start gap-3 border-l-2 border-border pl-3 relative">
      <div className="absolute w-2 h-2 rounded-full bg-border -left-[5px] top-1.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-semibold text-foreground">
            {o.kind}
          </span>
          <span className="text-muted-foreground text-xs">{ago(o.ts)}</span>
          {hasPayload && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOpen(!open)}
              className="text-xs h-auto py-0"
            >
              {open ? "▲ hide" : "▼ details"}
            </Button>
          )}
        </div>
        {open && hasPayload && (
          <pre className="text-muted-foreground mt-1 text-xs overflow-x-auto bg-muted p-2 rounded-md">
            {JSON.stringify(o.payload, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

export function RunOpsTimeline({ ops }: { ops: RunOpsDetail["ops"] }) {
  if (ops.length === 0)
    return (
      <p className="text-muted-foreground text-sm">
        No diagnostic events recorded.
      </p>
    );
  return (
    <div className="space-y-2">
      {ops.map((o) => (
        <TimelineRow key={o.seq} o={o} />
      ))}
    </div>
  );
}
