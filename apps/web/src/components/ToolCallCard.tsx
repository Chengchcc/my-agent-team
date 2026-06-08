"use client";

import { useState } from "react";

export function ToolCallCard({
  name,
  input,
}: {
  id?: string;
  name: string;
  input: unknown;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-l-2 border-[var(--teal)] bg-[var(--paper)] my-2 ml-4">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full text-left px-4 py-3 flex items-center gap-3"
      >
        <span className="font-[family-name:var(--font-mono)] text-[10px] tracking-[0.15em] uppercase text-[var(--teal)]">
          Tool: {name}
        </span>
        <span className="font-[family-name:var(--font-mono)] text-[9px] text-[var(--warm-gray-dark)]">
          {open ? "collapse ▲" : "expand ▼"}
        </span>
      </button>
      {open && (
        <pre className="px-4 pb-3 font-[family-name:var(--font-mono)] text-[11px] text-[var(--charcoal)]/70 overflow-x-auto max-h-40 leading-relaxed">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}
