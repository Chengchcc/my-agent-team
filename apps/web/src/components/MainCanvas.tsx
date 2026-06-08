"use client";

import type { ReactNode } from "react";

interface MainCanvasProps {
  children?: ReactNode;
  emptyState?: ReactNode;
  statusLine?: { text: string; badge?: string } | null;
}

export function MainCanvas({
  children,
  emptyState,
  statusLine,
}: MainCanvasProps) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-8 py-8">
        {/* Progress mirror — current step / tool / status */}
        {statusLine && (
          <div className="mb-6 flex items-center gap-2 animate-fade-in">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--brass)] animate-[dot-pulse_1.5s_ease-in-out_infinite]" />
            <span className="font-[family-name:var(--font-mono)] text-[10px] tracking-[0.15em] uppercase text-[var(--warm-gray-dark)]">
              {statusLine.text}
            </span>
            {statusLine.badge && (
              <span className="font-[family-name:var(--font-mono)] text-[9px] text-[var(--teal)] border border-[var(--teal)]/40 px-1.5 py-0.5">
                {statusLine.badge}
              </span>
            )}
          </div>
        )}

        {/* Content or empty state */}
        {children ?? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            {emptyState ?? (
              <>
                <div className="w-16 h-16 mb-6 rounded-full bg-[var(--warm-gray)] flex items-center justify-center">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1"
                    className="text-[var(--warm-gray-dark)]"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                  </svg>
                </div>
                <p className="font-[family-name:var(--font-heading)] text-sm text-[var(--warm-gray-dark)] mb-2">
                  Output will appear here
                </p>
                <p className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--warm-gray-dark)] max-w-xs">
                  Structured outputs — code, tables, documents — surface in this
                  area while you monitor the process on the right.
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
