"use client";

import { useState } from "react";
import { normalizeToolResultContent } from "@/lib/render-blocks";

export function ToolStep({
  name,
  input,
  result,
}: {
  name: string;
  input: unknown;
  result?: { content: string; isError?: boolean };
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="font-[family-name:var(--font-mono)] text-[12px]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-left hover:text-[var(--ink)] transition-colors text-[var(--mute)]"
      >
        <span className="text-[var(--primary)]">→</span>
        <span className="text-[var(--primary)]">{name}</span>
        <span className="text-[var(--hairline-soft)]">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="pl-4 mt-1 flex flex-col gap-1">
          <pre className="text-[var(--canvas-text-soft)] bg-[var(--canvas-soft)] rounded p-2 overflow-x-auto max-h-40">
            {JSON.stringify(input, null, 2)}
          </pre>
          {result && (
            <pre
              className={`rounded p-2 overflow-x-auto max-h-40 ${
                result.isError ? "text-red-400" : "text-[var(--body)]"
              } bg-[var(--canvas-soft)]`}
            >
              {"⤷ "}
              {normalizeToolResultContent(result.content)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
