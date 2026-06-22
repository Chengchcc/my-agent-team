"use client";

import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { NavRail } from "./NavRail";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <NavRail />
      <main className="flex-1 min-w-0 overflow-y-auto min-h-svh bg-background">
        <SidebarTrigger className="absolute top-3 left-3 z-20" />
        {children}
      </main>
      <Toaster />
    </>
  );
}
