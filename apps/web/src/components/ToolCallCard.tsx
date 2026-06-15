"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function ToolCallCard({ name, input }: { id?: string; name: string; input: unknown }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border border-[var(--hairline)] rounded-lg bg-[var(--canvas)] my-2 mx-0 overflow-hidden">
      <Button
        onClick={() => setOpen(!open)}
        className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-[var(--canvas-soft)] transition-colors"
      >
        <span className="text-[10px] tracking-[0.15em] uppercase font-[family-name:var(--font-sans)] font-semibold text-[var(--primary)]">
          Tool: {name}
        </span>
        <span className="text-[10px] text-[var(--mute)]">{open ? "▲ collapse" : "▼ expand"}</span>
      </Button>
      <div
        className="grid transition-all duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <pre className="px-4 pb-3 text-[13px] text-[var(--canvas-text-soft)] overflow-x-auto max-h-40 leading-relaxed font-[family-name:var(--font-mono)] bg-[var(--canvas-soft)] mx-2 mb-2 rounded p-3">
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}
