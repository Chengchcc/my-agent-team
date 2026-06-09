"use client";

import { useState } from "react";

interface ToolApprovalCardProps {
  tool: { id: string; name: string; input: unknown };
  onApprove: (message?: string) => void;
  onDeny: (message?: string) => void;
  disabled?: boolean;
}

export function ToolApprovalCard({ tool, onApprove, onDeny, disabled }: ToolApprovalCardProps) {
  const [message, setMessage] = useState("");

  return (
    <div className="border-t-2 border-[var(--primary)] bg-[var(--canvas)]">
      <div className="px-6 py-5 mx-auto" style={{ maxWidth: "72ch" }}>
        {/* Header */}
        <div className="flex items-center gap-3 mb-3">
          <span className="w-2 h-2 rounded-full bg-[var(--primary)]" />
          <p className="text-[10px] tracking-[0.15em] uppercase font-[family-name:var(--font-sans)] font-semibold text-[var(--primary)]">
            Approval Required
          </p>
        </div>

        <p className="text-sm text-[var(--ink)] mb-2">
          Agent requests to use{" "}
          <span className="text-[13px] font-[family-name:var(--font-mono)] bg-[var(--canvas-soft)] px-1.5 py-0.5 border border-[var(--hairline)] rounded text-[var(--canvas-text-soft)]">
            {tool.name}
          </span>
        </p>

        <pre className="text-[13px] text-[var(--mute)] mb-4 max-h-20 overflow-y-auto leading-relaxed font-[family-name:var(--font-mono)] bg-[var(--canvas-soft)] rounded p-3">
          {JSON.stringify(tool.input, null, 2)}
        </pre>

        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Optional feedback..."
          className="w-full bg-[var(--canvas-soft)] border border-[var(--hairline)] rounded-md
                     px-3 py-2 mb-4 text-sm text-[var(--ink)]
                     placeholder:text-[var(--mute)]
                     focus:outline-none focus:border-[var(--primary)]
                     transition-colors duration-200"
        />

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => onApprove(message || undefined)}
            disabled={disabled}
            className="bg-[var(--primary)] text-[var(--on-primary)]
                       rounded-md px-5 py-2 text-sm font-semibold
                       hover:opacity-90
                       disabled:opacity-40 disabled:cursor-not-allowed
                       transition-opacity duration-200"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => onDeny(message || undefined)}
            disabled={disabled}
            className="border border-[var(--hairline)] text-[var(--body)]
                       rounded-md px-5 py-2 text-sm font-semibold
                       hover:border-[var(--ink)] hover:text-[var(--ink)]
                       disabled:opacity-40 disabled:cursor-not-allowed
                       transition-colors duration-200"
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
