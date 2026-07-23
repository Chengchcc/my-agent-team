"use client";

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

  return <GlobalSearch open={open} onClose={handleClose} />;
}
