"use client";

import type { ReactNode } from "react";
import { NavRail } from "./NavRail";
import { useShell } from "./ShellProvider";

export function AppShell({ children }: { children: ReactNode }) {
  const { drawerCollapsed, drawerContent } = useShell();

  return (
    <div className="flex h-screen bg-[var(--cream)] overflow-hidden">
      {/* NavRail — global left sidebar */}
      <NavRail />

      {/* Main work surface — route content */}
      <main
        className="flex-1 min-w-0 overflow-hidden transition-[margin-right] duration-300 ease-out"
        style={{ marginRight: drawerContent && !drawerCollapsed ? "380px" : "0" }}
      >
        {children}
      </main>

      {/* Agent Drawer — right process panel (conditional) */}
      {drawerContent && (
        <div
          className="fixed top-0 right-0 h-full border-l border-[var(--border-color)] bg-[var(--cream)] overflow-hidden transition-transform duration-300 ease-out z-10"
          style={{
            width: "380px",
            transform: drawerCollapsed ? "translateX(100%)" : "translateX(0)",
          }}
        >
          {drawerContent}
        </div>
      )}
    </div>
  );
}
