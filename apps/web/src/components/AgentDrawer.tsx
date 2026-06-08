"use client";

import type { ReactNode } from "react";
import { useShell } from "./ShellProvider";

export function AgentDrawer({ children }: { children: ReactNode }) {
  const { drawerCollapsed, toggleDrawer } = useShell();

  return (
    <>
      {/* Collapse toggle tab — always visible on the left edge of the drawer */}
      <button
        type="button"
        onClick={toggleDrawer}
        className="absolute top-4 -left-8 w-8 h-10 flex items-center justify-center bg-[var(--paper)] border border-[var(--border-color)] border-r-0 rounded-l text-[var(--warm-gray-dark)] hover:text-[var(--brass)] transition-colors z-20"
        aria-label={drawerCollapsed ? "Expand drawer" : "Collapse drawer"}
        title={drawerCollapsed ? "Expand drawer" : "Collapse drawer"}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          style={{
            transform: drawerCollapsed ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.3s ease",
          }}
        >
          <path d="M10 4l-4 4 4 4" />
        </svg>
      </button>

      {/* Drawer content */}
      <div className="h-full flex flex-col overflow-hidden relative">
        {/* Drawer header */}
        <div className="px-4 py-3 border-b border-[var(--border-color)] flex items-center justify-between shrink-0">
          <span className="font-[family-name:var(--font-mono)] text-[9px] tracking-[0.15em] uppercase text-[var(--warm-gray-dark)]">
            Process
          </span>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </>
  );
}
