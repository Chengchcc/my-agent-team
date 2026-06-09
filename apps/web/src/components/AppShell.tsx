"use client";

import type { ReactNode } from "react";
import { NavRail } from "./NavRail";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen bg-[var(--canvas)] overflow-hidden">
      <NavRail />
      <main className="flex-1 min-w-0 overflow-hidden">{children}</main>
    </div>
  );
}
