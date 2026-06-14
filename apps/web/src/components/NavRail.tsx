"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useShell } from "./ShellProvider";

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

  if (railCollapsed) {
    return (
      <aside
        className="h-full border-r border-[var(--hairline)] bg-[var(--canvas)] flex flex-col items-center py-4 gap-3 shrink-0"
        style={{ width: "3rem" }}
      >
        <button
          type="button"
          onClick={toggleRail}
          className="w-7 h-7 flex items-center justify-center text-[var(--mute)] hover:text-[var(--primary)] transition-colors"
          aria-label="Expand sidebar"
        >
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
        </button>
        <Link
          href="/agents"
          className="w-7 h-7 flex items-center justify-center rounded-full text-[var(--mute)] hover:text-[var(--ink)] transition-colors"
          aria-label="Agents"
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
        <Link
          href="/ops"
          className="w-7 h-7 flex items-center justify-center rounded-full text-[var(--mute)] hover:text-[var(--ink)] transition-colors"
          aria-label="Ops"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="1" y="1" width="6" height="5" rx="1" />
            <rect x="9" y="1" width="6" height="5" rx="1" />
            <rect x="1" y="10" width="6" height="5" rx="1" />
            <rect x="9" y="10" width="6" height="5" rx="1" />
          </svg>
        </Link>
        <div className="flex-1 w-px bg-[var(--hairline)]" />
      </aside>
    );
  }

  return (
    <aside
      className="h-full border-r border-[var(--hairline)] bg-[var(--canvas)] flex flex-col shrink-0 overflow-hidden"
      style={{ width: "240px" }}
    >
      {/* Header */}
      <div className="px-4 py-4 border-b border-[var(--hairline)] flex items-center justify-between">
        <Link
          href="/agents"
          className="text-sm font-medium text-[var(--ink-strong)] hover:text-[var(--primary)] transition-colors"
        >
          Observatory
        </Link>
        <button
          type="button"
          onClick={toggleRail}
          className="w-6 h-6 flex items-center justify-center text-[var(--mute)] hover:text-[var(--primary)] transition-colors"
          aria-label="Collapse sidebar"
        >
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
        </button>
      </div>

      {/* Agents section */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 pt-4 pb-2">
          <h2 className="text-[10px] tracking-[2.52px] uppercase text-[var(--mute)] mb-2 font-[family-name:var(--font-sans)] font-semibold">
            Agents
          </h2>
          {activeAgents.length === 0 && <p className="text-xs text-[var(--mute)]">No agents yet</p>}
          <ul className="space-y-0.5">
            {activeAgents.map((agent, i) => (
              <li
                key={agent.id}
                className="animate-fade-in"
                style={{ animationDelay: `${i * 0.05}s` }}
              >
                <button
                  type="button"
                  onClick={() => router.push(`/agents/${agent.id}`)}
                  className={`w-full text-left px-2 py-1.5 text-sm rounded-md transition-colors ${
                    isAgentActive(agent.id)
                      ? "bg-[var(--canvas-soft)] text-[var(--ink)] border-l-2 border-[var(--primary)]"
                      : "text-[var(--body)] hover:bg-[var(--canvas-soft)] hover:text-[var(--ink)]"
                  }`}
                >
                  <div className="truncate">{agent.name}</div>
                  <div className="text-[10px] text-[var(--mute)] truncate mt-0.5">
                    {agent.modelName}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Conversations section */}
        {selectedAgentId && (
          <div className="px-4 pt-2 pb-4 border-t border-[var(--hairline)]">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-[10px] tracking-[2.52px] uppercase text-[var(--mute)] font-[family-name:var(--font-sans)] font-semibold">
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
                className="text-[var(--primary)] hover:text-[var(--primary-soft)] transition-colors"
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
              <p className="text-xs text-[var(--mute)]">No conversations yet</p>
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
                        ? "bg-[var(--canvas-soft)] text-[var(--ink)] border-l-2 border-[var(--primary)]"
                        : "text-[var(--body)] hover:bg-[var(--canvas-soft)] hover:text-[var(--ink)]"
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
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-[var(--hairline)] flex items-center justify-between">
        <Link
          href="/ops"
          className="text-[9px] tracking-[0.15em] uppercase text-[var(--mute)] hover:text-[var(--ink)] transition-colors"
        >
          Ops
        </Link>
        <Link
          href="/api/auth/logout"
          className="text-[9px] tracking-[0.15em] uppercase text-[var(--mute)] hover:text-[var(--body)] transition-colors"
        >
          Sign Out
        </Link>
      </div>
    </aside>
  );
}
