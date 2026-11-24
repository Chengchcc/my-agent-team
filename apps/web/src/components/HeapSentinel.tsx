"use client";

import { useEffect } from "react";
import { toast } from "sonner";

/** "Resources have an upper bound" (P0 of the 2026-11-24 console review): a
 *  renderer that grew to 2.4 GB in two hours was only noticed because the
 *  browser got sluggish. The sentinel does not fix a leak; it makes one
 *  visible while the person can still act — once per page, not every minute.
 *
 *  `performance.memory` is Chromium-only; where it is absent this is a no-op. */
const SAMPLE_MS = 60_000;
const THRESHOLD_MB = 500;

type MemoryWithHeap = Performance & {
  memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
};

export function HeapSentinel() {
  useEffect(() => {
    const perf = performance as MemoryWithHeap;
    if (perf.memory === undefined) return;
    let warned = false;
    const check = (): void => {
      if (warned) return;
      const usedMb = Math.round((perf.memory?.usedJSHeapSize ?? 0) / 1_048_576);
      if (usedMb < THRESHOLD_MB) return;
      warned = true;
      toast.warning("This page is using a lot of memory", {
        description: `${usedMb} MB of JavaScript heap. Something here keeps growing; a reload clears it.`,
        duration: Number.POSITIVE_INFINITY,
        action: { label: "Reload", onClick: () => window.location.reload() },
      });
    };
    const timer = setInterval(check, SAMPLE_MS);
    return () => clearInterval(timer);
  }, []);
  return null;
}
