"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useShell } from "./ShellProvider";

const OPS_LINKS = [
  { label: "Overview", href: "/ops", exact: true },
  { label: "Runs", href: "/ops/runs", exact: false },
  { label: "Agents", href: "/ops/agents", exact: false },
  { label: "Traces", href: "/ops/traces", exact: false },
  { label: "Surfaces", href: "/ops/surfaces", exact: false },
] as const;

export function NavRail() {
  const { railCollapsed, toggleRail } = useShell();
  const pathname = usePathname();
  const router = useRouter();

  const { data: agents } = useQuery({
    queryKey: ["agents"],
    queryFn: api.listAgents,
    staleTime: 30_000,
  });

  const agentIdMatch = pathname.match(/\/agents\/([^/]+)/);
  const selectedAgentId = agentIdMatch?.[1] ?? null;

  const { data: conversations } = useQuery({
    queryKey: ["conversations", selectedAgentId],
    queryFn: () => api.listConversations(selectedAgentId!),
    enabled: !!selectedAgentId,
    staleTime: 10_000,
  });

  const activeAgents = (agents ?? []).filter((a) => !a.archivedAt);

  const isConvActive = (convId: string) => pathname === `/conversations/${convId}`;
  const isAgentActive = (agentId: string) =>
    pathname === `/agents/${agentId}` || pathname.startsWith(`/agents/${agentId}`);

  const isOpsActive = (href: string, exact: boolean) =>
    exact ? pathname === href : pathname.startsWith(href);

  // ── Collapsed ──────────────────────────────────────────

  if (railCollapsed) {
    return (
      <aside
        className="h-full border-r border-border bg-background flex flex-col items-center py-4 gap-3 shrink-0"
        style={{ width: "3rem" }}
      >
        <Button variant="ghost" size="icon" onClick={toggleRail} aria-label="Expand sidebar">
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M6 4l4 4-4 4" />
          </svg>
        </Button>

        {/* Workspace icon */}
        <Link
          href="/agents"
          className="w-7 h-7 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Workspace"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="6" cy="5" r="2" />
            <circle cx="10" cy="5" r="2" />
            <path d="M2 13c0-2 1.8-3 4-3s4 1 4 3" />
            <path d="M10 13c0-2 2-3 4-3" />
          </svg>
        </Link>

        {/* Operations icon */}
        <Link
          href="/ops"
          className="w-7 h-7 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Operations"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <rect x="1" y="1" width="6" height="5" rx="1" />
            <rect x="9" y="1" width="6" height="5" rx="1" />
            <rect x="1" y="10" width="6" height="5" rx="1" />
            <rect x="9" y="10" width="6" height="5" rx="1" />
          </svg>
        </Link>

        {/* Issues icon (M18.1) */}
        <Link
          href="/issues"
          className={`w-7 h-7 flex items-center justify-center rounded-full transition-colors ${
            pathname.startsWith("/issues")
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
          aria-label="Issues"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="currentColor"
            xmlns="http://www.w3.org/2000/svg"
          >
            <rect x="1" y="2" width="4" height="5" rx="1" />
            <rect x="6" y="5" width="4" height="8" rx="1" />
            <rect x="11" y="1" width="4" height="11" rx="1" />
          </svg>
        </Link>

        <div className="flex-1 w-px bg-border" />
      </aside>
    );
  }

  // ── Expanded ──────────────────────────────────────────

  return (
    <aside
      className="h-full border-r border-border bg-background flex flex-col shrink-0 overflow-hidden"
      style={{ width: "240px" }}
    >
      {/* Header */}
      <div className="px-4 py-4 border-b border-border flex items-center justify-between">
        <Link
          href="/agents"
          className="text-sm font-medium text-foreground-strong hover:text-primary transition-colors"
        >
          Operations
        </Link>
        <Button variant="ghost" size="icon-sm" onClick={toggleRail} aria-label="Collapse sidebar">
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M10 4l-4 4 4 4" />
          </svg>
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* ── Workspace section ── */}
        <div className="px-4 pt-4 pb-2">
          <h2 className="text-[10px] tracking-[2.52px] uppercase text-muted-foreground mb-2 font-[family-name:var(--font-sans)] font-semibold">
            Workspace
          </h2>

          <ul className="space-y-0.5">
            {activeAgents.length === 0 && (
              <p className="text-xs text-muted-foreground px-2">No agents yet</p>
            )}
            {activeAgents.map((agent, i) => (
              <li
                key={agent.id}
                className="animate-fade-in"
                style={{ animationDelay: `${i * 0.05}s` }}
              >
                <button
                  type="button"
                  title={agent.name}
                  onClick={() => router.push(`/agents/${agent.id}`)}
                  className={`w-full text-left px-2 py-1.5 text-sm rounded-md transition-colors ${
                    isAgentActive(agent.id)
                      ? "bg-muted text-foreground border-l-2 border-primary"
                      : "text-foreground-muted hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <div className="truncate">{agent.name}</div>
                  <div className="text-[10px] text-muted-foreground truncate mt-0.5">
                    {agent.modelName}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Conversations section */}
        {selectedAgentId && (
          <div className="px-4 pt-2 pb-4 border-t border-border">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-[10px] tracking-[2.52px] uppercase text-muted-foreground font-[family-name:var(--font-sans)] font-semibold">
                Conversations
              </h2>
              <button
                type="button"
                onClick={async () => {
                  const agent = (agents ?? []).find((a) => a.id === selectedAgentId);
                  const humanId = `human-${crypto.randomUUID().slice(0, 8)}`;
                  const conv = await api.createConversation({
                    members: [
                      {
                        memberId: selectedAgentId,
                        kind: "agent",
                        agentId: selectedAgentId,
                        displayName: agent?.name,
                      },
                      {
                        memberId: humanId,
                        kind: "human",
                        userRef: "__legacy__",
                        displayName: "User",
                      },
                    ],
                  });
                  router.push(`/conversations/${conv.conversationId}`);
                }}
                className="text-primary hover:text-primary/80 transition-colors"
                aria-label="New conversation"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M8 3v10M3 8h10" />
                </svg>
              </button>
            </div>
            {(conversations ?? []).length === 0 && (
              <p className="text-xs text-muted-foreground">No conversations yet</p>
            )}
            <ul className="space-y-0.5">
              {(conversations ?? []).map((conv, i) => (
                <li
                  key={conv.conversationId}
                  className="animate-fade-in"
                  style={{ animationDelay: `${i * 0.04}s` }}
                >
                  <button
                    type="button"
                    onClick={() => router.push(`/conversations/${conv.conversationId}`)}
                    className={`w-full text-left px-2 py-1.5 text-sm rounded-md transition-colors truncate block ${
                      isConvActive(conv.conversationId)
                        ? "bg-muted text-foreground border-l-2 border-primary"
                        : "text-foreground-muted hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    <span className="truncate">
                      {conv.title ?? `Conversation ${conv.conversationId.slice(0, 6)}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── Issues section (M18.1) ── */}
        <div className="px-4 pt-4 pb-2 border-t border-border">
          <h2 className="text-[10px] tracking-[2.52px] uppercase text-muted-foreground mb-2 font-[family-name:var(--font-sans)] font-semibold">
            Issues
          </h2>
          <ul className="space-y-0.5">
            <li>
              <Link
                href="/issues"
                className={`block px-2 py-1.5 text-sm rounded-md transition-colors ${
                  pathname.startsWith("/issues")
                    ? "bg-muted text-foreground border-l-2 border-primary"
                    : "text-foreground-muted hover:bg-muted hover:text-foreground"
                }`}
              >
                Board
              </Link>
            </li>
          </ul>
        </div>

        {/* ── Operations section ── */}
        <div className="px-4 pt-4 pb-2 border-t border-border">
          <h2 className="text-[10px] tracking-[2.52px] uppercase text-muted-foreground mb-2 font-[family-name:var(--font-sans)] font-semibold">
            Operations
          </h2>
          <ul className="space-y-0.5">
            {OPS_LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className={`block px-2 py-1.5 text-sm rounded-md transition-colors ${
                    isOpsActive(link.href, link.exact)
                      ? "bg-muted text-foreground border-l-2 border-primary"
                      : "text-foreground-muted hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-border">
        <form action="/api/auth/logout" method="POST">
          <button
            type="submit"
            className="text-[10px] tracking-[0.15em] uppercase text-muted-foreground hover:text-foreground-muted transition-colors"
          >
            Sign Out
          </button>
        </form>
      </div>
    </aside>
  );
}
