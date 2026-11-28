"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { GlobalSearch } from "@/components/GlobalSearch";
import { HeapSentinel } from "@/components/HeapSentinel";
import { NetworkStatus } from "@/components/NetworkStatus";
import { Toaster } from "@/components/ui/sonner";
import { CodingNotifier } from "@/features/coding/components/coding-notifier";
import { hasLocale, setLocale } from "@/lib/i18n";
import { NavRail } from "./NavRail";
import { TopBar } from "./TopBar";

/** Single search instance: one Cmd+K handler, one modal, one visible
 *  trigger (TopBar). No global floating pill. */
export function AppShell({ children, locale }: { children: ReactNode; locale: string }) {
  // Applied during render, before the children below it render — on the server
  // as well, so the HTML and the hydration agree on one language.
  setLocale(hasLocale(locale) ? locale : "en");
  const [searchOpen, setSearchOpen] = useState(false);
  // The locale is settled by "@/lib/i18n" at import time (from the cookie,
  // which the server read too), so the first render is already correct. An
  // effect that re-rendered only this component left `{children}` untouched —
  // React skips a child whose element reference did not change — which is why
  // switching used to move the shell and nothing else (measured 2026-11-24).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <>
      <HeapSentinel />
      <NetworkStatus />
      <CodingNotifier />
      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
      <NavRail />
      <main className="relative flex flex-1 min-w-0 flex-col overflow-y-auto h-svh bg-background">
        <TopBar onSearch={() => setSearchOpen(true)} />
        {children}
      </main>
      <Toaster />
    </>
  );
}
