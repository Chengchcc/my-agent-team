"use client";

import { useState } from "react";
import type { LiveToolCall } from "@/lib/transient-reducer";

/** Transient live tool step shown inside a streaming assistant bubble.
 *  Raw tool input never reaches the browser — the child sends only the
 *  tool-authored, sanitized activity line. When a tool cannot describe
 *  itself the step shows its name; nothing is fabricated from the name. */

/** One class per state — a lookup, not a ternary chain: the previous
 *  `running ? … : error ? … : done` form nested two ternaries, and its
 *  sibling label ternary computed `tool.state` back to itself. */
const STATE_DOT: Record<LiveToolCall["state"], string> = {
  running: "bg-[var(--primary)] animate-pulse",
  error: "bg-red-400",
  done: "bg-emerald-400",
};

export function LiveToolStep({ tool }: { tool: LiveToolCall }) {
  const [open, setOpen] = useState(false);

  const stateDot = STATE_DOT[tool.state];

  return (
    <div className="mt-1 min-w-0 rounded-md border border-(--hairline) bg-(--canvas-soft) px-2 py-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className={`size-1.5  shrink-0 rounded-full ${stateDot}`} />
        <span
          className={`min-w-0 truncate text-xs text-(--ink)${tool.activity ? "" : " font-mono"}`}
        >
          {tool.activity ?? tool.name}
        </span>
        {tool.activity && (
          <span className="shrink-0 font-mono text-[10px] text-(--mute)">{tool.name}</span>
        )}
        <span className="text-[10px] text-(--mute)">{tool.state}</span>
        {tool.result !== undefined && (
          <span className="ml-auto text-[10px] text-(--mute)">{open ? "hide" : "result"}</span>
        )}
      </button>
      {open && tool.result !== undefined && (
        <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-(--canvas) p-2 font-mono text-[10px] text-(--mute) wrap-anywhere">
          {typeof tool.result === "string" ? tool.result : JSON.stringify(tool.result, null, 2)}
        </pre>
      )}
    </div>
  );
}
