"use client";

import { useState } from "react";

interface ToolApprovalCardProps {
  tool: { id: string; name: string; input: unknown };
  onApprove: (message?: string) => void;
  onDeny: (message?: string) => void;
  disabled?: boolean;
}

export function ToolApprovalCard({
  tool,
  onApprove,
  onDeny,
  disabled,
}: ToolApprovalCardProps) {
  const [message, setMessage] = useState("");

  return (
    <div className="border-t-2 border-[var(--brass-light)] bg-[var(--paper)]">
      <div className="px-6 py-5 max-w-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 mb-3">
          <span className="w-2 h-2 rounded-full bg-[var(--brass)]" />
          <p className="font-[family-name:var(--font-mono)] text-[10px] tracking-[0.15em] uppercase text-[var(--brass)]">
            Approval Required
          </p>
        </div>

        <p className="font-[family-name:var(--font-heading)] text-sm text-[var(--charcoal)] mb-2">
          Agent requests to use{" "}
          <span className="font-[family-name:var(--font-mono)] text-[10px] tracking-[0.1em] not-italic bg-[var(--cream)] px-1.5 py-0.5 border border-[var(--border-color)]">
            {tool.name}
          </span>
        </p>

        <pre className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--charcoal)]/60 mb-4 max-h-20 overflow-y-auto leading-relaxed">
          {JSON.stringify(tool.input, null, 2)}
        </pre>

        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Optional feedback..."
          className="w-full bg-transparent border-0 border-b border-[var(--border-color)]
                     px-0 py-2 mb-4 font-[family-name:var(--font-heading)] text-sm
                     text-[var(--charcoal)] placeholder:text-[var(--border-color)]
                     focus:outline-none focus:border-[var(--brass)]
                     transition-colors duration-300"
        />

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => onApprove(message || undefined)}
            disabled={disabled}
            className="border border-[var(--teal)] bg-[var(--teal)] text-[var(--cream)]
                       px-5 py-2 font-[family-name:var(--font-mono)] text-[10px] tracking-[0.15em] uppercase
                       hover:bg-[var(--teal-light)] hover:border-[var(--teal-light)]
                       disabled:opacity-40 disabled:cursor-not-allowed
                       transition-colors duration-300"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => onDeny(message || undefined)}
            disabled={disabled}
            className="border border-[var(--rust)] text-[var(--rust)]
                       px-5 py-2 font-[family-name:var(--font-mono)] text-[10px] tracking-[0.15em] uppercase
                       hover:bg-[var(--rust)] hover:text-[var(--cream)]
                       disabled:opacity-40 disabled:cursor-not-allowed
                       transition-colors duration-300"
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
