"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

interface ShellContextValue {
  railCollapsed: boolean;
  toggleRail: () => void;
  drawerCollapsed: boolean;
  toggleDrawer: () => void;
  drawerContent: ReactNode | null;
  setDrawerContent: (content: ReactNode | null) => void;
}

const ShellContext = createContext<ShellContextValue | null>(null);

function loadCollapseState(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const v = localStorage.getItem(key);
    return v !== null ? v === "1" : fallback;
  } catch {
    return fallback;
  }
}

function saveCollapseState(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // localStorage unavailable
  }
}

export function ShellProvider({ children }: { children: ReactNode }) {
  const [railCollapsed, setRailCollapsed] = useState(() =>
    loadCollapseState("maw_rail_collapsed", false),
  );
  const [drawerCollapsed, setDrawerCollapsed] = useState(() =>
    loadCollapseState("maw_drawer_collapsed", false),
  );
  const [drawerContent, setDrawerContent] = useState<ReactNode | null>(null);

  const toggleRail = useCallback(() => {
    setRailCollapsed((prev) => {
      saveCollapseState("maw_rail_collapsed", !prev);
      return !prev;
    });
  }, []);

  const toggleDrawer = useCallback(() => {
    setDrawerCollapsed((prev) => {
      saveCollapseState("maw_drawer_collapsed", !prev);
      return !prev;
    });
  }, []);

  return (
    <ShellContext.Provider
      value={{
        railCollapsed,
        toggleRail,
        drawerCollapsed,
        toggleDrawer,
        drawerContent,
        setDrawerContent,
      }}
    >
      {children}
    </ShellContext.Provider>
  );
}

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used within ShellProvider");
  return ctx;
}
