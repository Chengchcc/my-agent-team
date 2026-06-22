"use client";

import type { ReactNode } from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { NavRail } from "./NavRail";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <NavRail />
      <main className="relative flex-1 min-w-0 overflow-y-auto min-h-svh bg-background">
        <div className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-border bg-background/80 px-3 backdrop-blur md:hidden">
          <SidebarTrigger />
        </div>
        {children}
      </main>
      <Toaster />
    </>
  );
}
