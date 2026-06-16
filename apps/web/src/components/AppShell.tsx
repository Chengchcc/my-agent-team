"use client";

import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { NavRail } from "./NavRail";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <NavRail />
      <main className="flex-1 min-w-0 overflow-y-auto">{children}</main>
      <Toaster />
    </div>
  );
}
