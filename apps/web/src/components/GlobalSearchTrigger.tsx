"use client";

import { Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { GlobalSearch } from "./GlobalSearch";

export function GlobalSearchTrigger() {
  const [open, setOpen] = useState(false);
  const handleClose = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <>
      <GlobalSearch open={open} onClose={handleClose} />
      {/* Floating hint button — bottom-right corner */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full border border-[var(--hairline)] bg-[var(--canvas)] px-3 py-1.5 text-xs text-[var(--mute)] shadow-sm hover:text-[var(--ink)] hover:border-[var(--primary)] transition-colors"
        aria-label="Search conversations"
      >
        <Search className="h-3.5 w-3.5" />
        <kbd className="font-mono text-[10px]">Cmd+K</kbd>
      </button>
    </>
  );
}
