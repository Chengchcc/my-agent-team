"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "Overview", href: "/ops", exact: true },
  { label: "Runs", href: "/ops/runs", exact: false },
  { label: "Agents", href: "/ops/agents", exact: false },
  { label: "Traces", href: "/ops/traces", exact: false },
  { label: "Surfaces", href: "/ops/surfaces", exact: false },
] as const;

export function OpsTabs() {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1 border-b pb-0">
      {TABS.map((tab) => {
        const active = tab.exact
          ? pathname === tab.href
          : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`px-3 py-2 text-sm rounded-t-md transition-colors border-b-2 -mb-[1px] ${
              active
                ? "text-foreground border-primary"
                : "text-muted-foreground border-transparent hover:text-foreground hover:border-border"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
