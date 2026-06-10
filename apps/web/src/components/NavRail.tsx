"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
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

  const { data: threads } = useQuery({
    queryKey: ["threads", selectedAgentId],
    queryFn: () => api.listThreads(selectedAgentId!),
    enabled: !!selectedAgentId,
    staleTime: 10_000,
  });

  const agentThreads = (threads ?? []).filter((t) => t.kind === "agent_thread");

  const activeAgents = (agents ?? []).filter((a) => !a.archivedAt);

  const isThreadActive = (threadId: string) => pathname === `/conversations/${threadId}`;
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

        {/* Threads section */}
        {selectedAgentId && (
          <div className="px-4 pt-2 pb-4 border-t border-[var(--hairline)]">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-[10px] tracking-[2.52px] uppercase text-[var(--mute)] font-[family-name:var(--font-sans)] font-semibold">
                Threads
              </h2>
              <button
                type="button"
                onClick={async () => {
                  const thread = await api.createThread(selectedAgentId);
                  // Ensure conversation exists for the new thread (backfill is
                  // startup-only, so threads created at runtime need this).
                  const conv = await api.createConversation({
                    conversationId: thread.id,
                    members: [
                      { memberId: thread.agentId, kind: "agent", agentId: thread.agentId },
                      { memberId: `human-${thread.id}`, kind: "human", userRef: "__legacy__", displayName: "User" },
                    ],
                  });
                  console.log("[NavRail] created conversation", conv);
                  router.push(`/conversations/${thread.id}`);
                }}
                className="text-[var(--primary)] hover:text-[var(--primary-soft)] transition-colors"
                aria-label="New thread"
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
            {agentThreads.length === 0 && (
              <p className="text-xs text-[var(--mute)]">No threads yet</p>
            )}
            <ul className="space-y-0.5">
              {agentThreads.map((thread, i) => (
                <li
                  key={thread.id}
                  className="animate-fade-in"
                  style={{ animationDelay: `${i * 0.04}s` }}
                >
                  <button
                    type="button"
                    onClick={() => router.push(`/conversations/${thread.id}`)}
                    className={`w-full text-left px-2 py-1.5 text-sm rounded-md transition-colors truncate block ${
                      isThreadActive(thread.id)
                        ? "bg-[var(--canvas-soft)] text-[var(--ink)] border-l-2 border-[var(--primary)]"
                        : "text-[var(--body)] hover:bg-[var(--canvas-soft)] hover:text-[var(--ink)]"
                    }`}
                  >
                    <span className="flex items-center gap-1.5 truncate">
                      {thread.lastRunAt && (
                        <span
                          className="w-1 h-1 rounded-full shrink-0"
                          style={{
                            backgroundColor: isThreadActive(thread.id)
                              ? "var(--primary)"
                              : "var(--mute)",
                          }}
                        />
                      )}
                      <span className="truncate">
                        {thread.title ?? `Thread ${thread.id.slice(0, 6)}`}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-[var(--hairline)]">
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
