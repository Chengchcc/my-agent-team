"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/** A crashed segment shows a way back instead of Next's built-in line. Live
 *  2026-11-24: four triggers produced "Application error: a client-side
 *  exception has occurred" with no reload, no explanation — the whole shell
 *  went with it. This boundary keeps the shell (sidebar, navigation) and
 *  replaces only the page. */
export default function SegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[web] page error", error);
  }, [error]);
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-sm text-(--ink)">This page hit an error.</p>
      <p className="max-w-md font-mono text-[11px] text-(--mute)">
        {error.message || "Unknown error"}
        {error.digest ? ` · ${error.digest}` : ""}
      </p>
      <div className="flex gap-2">
        <Button size="sm" onClick={reset}>
          Try again
        </Button>
        <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    </div>
  );
}
