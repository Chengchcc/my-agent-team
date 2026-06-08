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

  // Determine selected agent from route
  const agentIdMatch = pathname.match(/\/agents\/([^/]+)/);
  const selectedAgentId = agentIdMatch?.[1] ?? null;

  // Fetch threads for selected agent
  const { data: threads } = useQuery({
    queryKey: ["threads", selectedAgentId],
    queryFn: () => api.listThreads(selectedAgentId!),
    enabled: !!selectedAgentId,
    staleTime: 10_000,
  });

  const agentThreads = (threads ?? []).filter(
    (t) => t.kind === "agent_thread",
  );

  const activeAgents = (agents ?? []).filter((a) => !a.archivedAt);

  const isThreadActive = (threadId: string) =>
    pathname === `/threads/${threadId}`;
  const isAgentActive = (agentId: string) =>
    pathname === `/agents/${agentId}` || pathname.startsWith(`/agents/${agentId}`);

  if (railCollapsed) {
    return (
      <aside
        className="h-full border-r border-[var(--border-color)] bg-[var(--paper)] flex flex-col items-center py-4 gap-3 shrink-0"
        style={{ width: "3rem" }}
      >
        <button
          type="button"
          onClick={toggleRail}
          className="w-7 h-7 flex items-center justify-center text-[var(--warm-gray-dark)] hover:text-[var(--brass)] transition-colors"
          aria-label="Expand sidebar"
          title="Expand sidebar"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M6 4l4 4-4 4" />
          </svg>
        </button>
        <Link
          href="/agents"
          className="w-7 h-7 flex items-center justify-center rounded-full text-[var(--warm-gray-dark)] hover:bg-[var(--warm-gray)] hover:text-[var(--charcoal)] transition-colors"
          aria-label="Agents"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="6" cy="5" r="2" />
            <circle cx="10" cy="5" r="2" />
            <path d="M2 13c0-2 1.8-3 4-3s4 1 4 3" />
            <path d="M10 13c0-2 2-3 4-3" />
          </svg>
        </Link>
        <div className="flex-1 w-px bg-[var(--border-color)]" />
      </aside>
    );
  }

  return (
    <aside
      className="h-full border-r border-[var(--border-color)] bg-[var(--paper)] flex flex-col shrink-0 overflow-hidden"
      style={{ width: "240px" }}
    >
      {/* Header */}
      <div className="px-4 py-4 border-b border-[var(--border-color)] flex items-center justify-between">
        <Link
          href="/agents"
          className="font-[family-name:var(--font-heading)] text-sm font-medium text-[var(--charcoal)] hover:text-[var(--brass)] transition-colors"
        >
          Observatory
        </Link>
        <button
          type="button"
          onClick={toggleRail}
          className="w-6 h-6 flex items-center justify-center text-[var(--warm-gray-dark)] hover:text-[var(--brass)] transition-colors"
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M10 4l-4 4 4 4" />
          </svg>
        </button>
      </div>

      {/* Agents section */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 pt-4 pb-2">
          <h2 className="font-[family-name:var(--font-mono)] text-[9px] tracking-[0.15em] uppercase text-[var(--warm-gray-dark)] mb-2">
            Agents
          </h2>
          {activeAgents.length === 0 && (
            <p className="text-xs text-[var(--warm-gray-dark)] italic">
              No agents yet
            </p>
          )}
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
                  className={`w-full text-left px-2 py-1.5 text-sm rounded transition-colors ${
                    isAgentActive(agent.id)
                      ? "bg-[var(--warm-gray)] text-[var(--charcoal)] font-medium"
                      : "text-[var(--charcoal)] hover:bg-[var(--warm-gray)]"
                  }`}
                >
                  <div className="truncate">{agent.name}</div>
                  <div className="font-[family-name:var(--font-mono)] text-[9px] text-[var(--warm-gray-dark)] truncate mt-0.5">
                    {agent.modelName}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Threads section — only when an agent is selected */}
        {selectedAgentId && (
          <div className="px-4 pt-2 pb-4 border-t border-[var(--border-color)]">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-[family-name:var(--font-mono)] text-[9px] tracking-[0.15em] uppercase text-[var(--warm-gray-dark)]">
                Threads
              </h2>
              <button
                type="button"
                onClick={async () => {
                  const thread = await api.createThread(selectedAgentId);
                  router.push(`/threads/${thread.id}`);
                }}
                className="text-[var(--brass)] hover:text-[var(--brass-light)] transition-colors"
                aria-label="New thread"
                title="New thread"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M8 3v10M3 8h10" />
                </svg>
              </button>
            </div>
            {agentThreads.length === 0 && (
              <p className="text-xs text-[var(--warm-gray-dark)] italic">
                No threads yet
              </p>
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
                    onClick={() => router.push(`/threads/${thread.id}`)}
                    className={`w-full text-left px-2 py-1.5 text-sm rounded transition-colors truncate block ${
                      isThreadActive(thread.id)
                        ? "bg-[var(--warm-gray)] text-[var(--charcoal)] font-medium"
                        : "text-[var(--charcoal)] hover:bg-[var(--warm-gray)]"
                    }`}
                  >
                    {thread.title ?? `Thread ${thread.id.slice(0, 6)}`}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-[var(--border-color)]">
        <Link
          href="/api/auth/logout"
          className="font-[family-name:var(--font-mono)] text-[9px] tracking-[0.15em] uppercase text-[var(--warm-gray-dark)] hover:text-[var(--rust)] transition-colors"
        >
          Sign Out
        </Link>
      </div>
    </aside>
  );
}
