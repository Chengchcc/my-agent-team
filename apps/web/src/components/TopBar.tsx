"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, Bell, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useAgentList } from "@/features/agents/hooks";
import { useCurrentUser } from "@/features/identity/hooks";
import { backendPingQuery, surfacesQuery } from "@/features/ops/queries";
import { waitingGatesQuery } from "@/features/workflow/queries";
import type { AgentRow } from "@/lib/api";

/** Runtime chip labels for known backend kinds; unknown kinds fall back. */
const CHIP_LABEL: Record<string, string> = {
  oma: "oma native",
  claude: "claude cli",
  "claude-code": "claude cli",
  pi: "pi cli",
  omp: "omp cli",
};

function chipLabel(kind: string) {
  return CHIP_LABEL[kind] ?? `${kind.toLowerCase()} cli`;
}

function OnlinePill() {
  const ping = useQuery(backendPingQuery());
  const online = !ping.isError;
  return (
    <span
      className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-kicker text-(--mute)"
      aria-live="polite"
    >
      <span
        className={`size-1.5 rounded-full ${online ? "animate-dot-pulse bg-(--ok)" : "bg-(--err)"}`}
      />
      {online ? `Online ${ping.data ?? "…"}ms` : "Offline"}
    </span>
  );
}

function RuntimeChips({ agents }: { agents?: AgentRow[] }) {
  const enabled = (agents ?? []).filter((a) => a.enabled !== false);
  const kinds = [...new Set(enabled.map((a) => a.backendKind).filter(Boolean))];
  if (kinds.length === 0) return null;
  return (
    <span className="hidden items-center gap-1 lg:flex">
      {kinds.slice(0, 4).map((kind) => (
        <span
          key={kind}
          className="rounded-sm border border-(--hairline) px-1.5 py-0.5 font-mono text-[10px] text-(--mute)"
        >
          {chipLabel(kind)}
        </span>
      ))}
    </span>
  );
}

/** User-facing Lark state. The producer emits running | degraded | error (plus
 *  configured when nothing was ever started), so the old `status === "healthy"`
 *  comparison was never true and the chip printed the raw vocabulary. */
function larkChipState(statuses: string[]): { label: string; tone: string } {
  if (statuses.includes("error")) return { label: "连接失败", tone: "var(--destructive)" };
  if (statuses.includes("degraded")) return { label: "需要处理", tone: "var(--destructive)" };
  if (statuses.includes("running")) return { label: "已上线", tone: "var(--accent-violet)" };
  return { label: "未连接", tone: "var(--muted-foreground)" };
}

function LarkChip() {
  const { data: surfaces } = useQuery(surfacesQuery());
  const larks = (surfaces ?? []).filter((s) => s.surface.toLowerCase().includes("lark"));
  if (larks.length === 0) return null;
  const { label, tone } = larkChipState(larks.map((s) => s.status));
  // One surface = one place to fix it; several = the ops page that lists them.
  const href = larks.length === 1 ? `/team/${larks[0]?.agentId}?tab=lark` : "/system";
  return (
    <Link
      href={href}
      className="hidden items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] md:flex"
      style={{
        borderColor: `color-mix(in srgb, ${tone} 30%, transparent)`,
        color: tone,
      }}
      title={`飞书：${label}`}
    >
      <ArrowLeftRight className="size-3" />
      飞书：{label}
    </Link>
  );
}

export function TopBar({ onSearch }: { onSearch: () => void }) {
  const router = useRouter();
  const { data: user } = useCurrentUser();
  const { data: agents } = useAgentList() as { data?: AgentRow[] };
  const { data: waitingGates } = useQuery(waitingGatesQuery());
  const initials = (user?.userId ?? "ua").slice(0, 2).toUpperCase();

  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-3 border-b border-(--hairline) bg-(--canvas)/80 px-3 backdrop-blur">
      <SidebarTrigger className="md:hidden" />
      <OnlinePill />
      <RuntimeChips agents={agents} />
      <LarkChip />

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onSearch}
          className="flex h-7 w-44 items-center gap-2 rounded-sm border border-(--hairline) bg-(--canvas) px-2 text-(--faint) transition-colors hover:border-(--hairline-soft) hover:text-(--mute) md:w-56"
          aria-label="Search"
        >
          <Search className="size-3.5" />
          <span className="text-xs">Search</span>
          <kbd className="ml-auto rounded-sm border border-(--hairline) px-1 font-mono text-[10px]">
            ⌘K
          </kbd>
        </button>

        <button
          type="button"
          onClick={() => router.push("/today")}
          className="relative flex size-7 items-center justify-center rounded-sm text-(--mute) transition-colors hover:bg-(--panel2) hover:text-(--ink)"
          aria-label={`Notifications: ${waitingGates ?? 0} workflow gates waiting`}
        >
          <Bell className="size-4" />
          {(waitingGates ?? 0) > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-(--accent-violet) font-mono text-[8px] font-semibold text-(--on-accent-violet)">
              {waitingGates}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => router.push("/system/settings")}
          className="flex size-7 items-center justify-center rounded-full border border-(--primary) font-mono text-[10px] font-semibold text-(--primary)"
          aria-label="Account settings"
        >
          {initials}
        </button>
      </div>
    </header>
  );
}
