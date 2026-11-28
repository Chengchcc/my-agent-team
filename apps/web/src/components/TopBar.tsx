"use client";

import { useQuery } from "@tanstack/react-query";
import { Bell, Search, Settings } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { backendPingQuery } from "@/features/ops/queries";
import { attentionQuery } from "@/features/runs/queries";
import { t } from "@/lib/i18n";

function OnlinePill() {
  const ping = useQuery(backendPingQuery());
  const online = !ping.isError;
  return (
    <span
      className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-kicker text-(--mute)"
      aria-live="polite"
    >
      <span
        className={`size-1.5 rounded-full ${
          online
            ? ping.data !== undefined && ping.data >= 2000
              ? "bg-(--warn)"
              : "animate-dot-pulse bg-(--ok)"
            : "bg-(--err)"
        }`}
      />
      {/* A number that is not measured yet is not shown: "…ms" reads as a
          measurement. Over two seconds the badge says so in the person's unit. */}
      {ping.isPending
        ? t("Checking…")
        : online
          ? ping.data === undefined
            ? t("Online")
            : ping.data >= 2000
              ? t("Slow {ms}", { ms: (ping.data / 1000).toFixed(1) })
              : t("Online {ms}ms", { ms: ping.data })
          : t("Offline")}
    </span>
  );
}

/** Global chrome: backend reachability, command search, attention inbox count (same truth
 *  source as /today), and settings shortcut. Per-PA Lark channels belong in /channels and
 *  per-agent runtime health belongs in /system — never flattened into a singular global badge. */
export function TopBar({ onSearch }: { onSearch: () => void }) {
  const router = useRouter();
  const { data: attention } = useQuery(attentionQuery());
  const waitingOnYou =
    (attention?.awaitingYou.length ?? 0) + (attention?.workflowHumanTasks?.length ?? 0);

  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-3 border-b border-(--hairline) bg-(--canvas)/80 px-3 backdrop-blur">
      <SidebarTrigger className="md:hidden" />
      <OnlinePill />

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onSearch}
          className="flex h-7 w-44 items-center gap-2 rounded-sm border border-(--hairline) bg-(--canvas) px-2 text-(--faint) transition-colors hover:border-(--hairline-soft) hover:text-(--mute) md:w-56"
          aria-label={t("Search")}
        >
          <Search className="size-3.5" />
          <span className="text-xs">{t("Search")}</span>
          <kbd className="ml-auto rounded-sm border border-(--hairline) px-1 font-mono text-[10px]">
            ⌘K
          </kbd>
        </button>

        <button
          type="button"
          onClick={() => router.push("/today")}
          className="relative flex size-7 items-center justify-center rounded-sm text-(--mute) transition-colors hover:bg-(--panel2) hover:text-(--ink)"
          aria-label={t("Waiting for you: {n}", { n: waitingOnYou })}
          title={t("Waiting for you: {n}", { n: waitingOnYou })}
        >
          <Bell className="size-4" />
          {waitingOnYou > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-(--accent-violet) font-mono text-[8px] font-semibold text-(--on-accent-violet)">
              {waitingOnYou}
            </span>
          )}
        </button>

        <Link
          href="/system/settings"
          className="flex size-7 items-center justify-center rounded-full border border-(--hairline) text-(--mute) transition-colors hover:border-(--primary) hover:text-(--primary)"
          aria-label={t("Settings")}
          title={t("Settings")}
        >
          <Settings className="size-3.5" />
        </Link>
      </div>
    </header>
  );
}
