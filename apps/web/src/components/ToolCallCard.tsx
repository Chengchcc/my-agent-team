"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export function ToolCallCard({ name, input }: { id?: string; name: string; input: unknown }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border border-[var(--hairline)] rounded-lg bg-[var(--canvas)] my-2 mx-0 overflow-hidden">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          render={
            <Button className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-[var(--canvas-soft)] transition-colors" />
          }
        >
          <span className="text-[10px] tracking-[0.15em] uppercase font-[family-name:var(--font-sans)] font-semibold text-[var(--primary)]">
            Tool: {name}
          </span>
          <span className="text-[10px] text-[var(--mute)]">{open ? "▲ collapse" : "▼ expand"}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="px-4 pb-3 text-[13px] text-[var(--canvas-text-soft)] overflow-x-auto max-h-40 leading-relaxed font-[family-name:var(--font-mono)] bg-[var(--canvas-soft)] mx-2 mb-2 rounded p-3">
            {JSON.stringify(input, null, 2)}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
