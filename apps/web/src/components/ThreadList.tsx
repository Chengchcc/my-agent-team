"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useRouter } from "next/navigation";

function isRecent(ts: number | null): boolean {
  if (!ts) return false;
  return Date.now() - ts < 5 * 60 * 1000; // 5 min
}

export function ThreadList({ agentId }: { agentId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: threads, isLoading } = useQuery({
    queryKey: ["threads", agentId],
    queryFn: () => api.listThreads(agentId),
  });

  const createThread = useMutation({
    mutationFn: () => api.createThread(agentId),
    onSuccess: (thread) => {
      queryClient.invalidateQueries({ queryKey: ["threads", agentId] });
      router.push(`/threads/${thread.id}`);
    },
  });

  const deleteThread = useMutation({
    mutationFn: (threadId: string) => api.deleteThread(threadId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["threads", agentId] });
    },
  });

  const agentThreads = (threads ?? []).filter(
    (t) => t.kind === "agent_thread",
  );

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <div key={i} className="border border-[var(--hairline)] rounded-lg p-6 animate-pulse">
            <div className="h-4 w-40 bg-[var(--canvas-soft)] mb-2" />
            <div className="h-3 w-24 bg-[var(--canvas-soft)]" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[10px] tracking-[2.52px] uppercase text-[var(--mute)] font-[family-name:var(--font-sans)] font-semibold">
          {agentThreads.length} thread{agentThreads.length !== 1 ? "s" : ""}
        </p>
        <button
          type="button"
          onClick={() => createThread.mutate()}
          disabled={createThread.isPending}
          className="bg-[var(--primary)] text-[var(--on-primary)]
                     rounded-md px-4 py-2 text-sm font-semibold
                     hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed
                     transition-opacity duration-200"
        >
          + New Thread
        </button>
      </div>

      {agentThreads.length === 0 ? (
        <div className="py-16 text-center border border-[var(--hairline)] rounded-lg">
          <p className="text-sm text-[var(--body)] mb-4">
            No threads yet
          </p>
          <button
            type="button"
            onClick={() => createThread.mutate()}
            disabled={createThread.isPending}
            className="text-sm text-[var(--primary)] hover:text-[var(--primary-soft)] transition-colors font-semibold"
          >
            Create your first thread →
          </button>
        </div>
      ) : (
        <div className="space-y-0.5">
          {agentThreads.map((thread, i) => (
            <button
              key={thread.id}
              type="button"
              onClick={() => router.push(`/threads/${thread.id}`)}
              className="w-full text-left border border-[var(--hairline)] rounded-lg
                         hover:border-[var(--primary)] transition-colors duration-200
                         animate-fade-in bg-[var(--canvas)]"
              style={{
                animationDelay: `${i * 0.06}s`,
                animationFillMode: "both",
              }}
            >
              <div className="px-6 py-5 flex items-center justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {isRecent(thread.lastRunAt) && (
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--primary)] shrink-0 animate-dot-pulse" />
                    )}
                    <h3 className="text-sm font-medium text-[var(--ink)] truncate">
                      {thread.title ?? "Untitled Thread"}
                    </h3>
                  </div>
                  <p className="text-[10px] text-[var(--mute)] mt-1 ml-4 font-[family-name:var(--font-mono)]">
                    {new Date(thread.createdAt).toLocaleDateString("en-US", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                    {thread.lastRunAt &&
                      ` · Last run ${new Date(thread.lastRunAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}`}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0 ml-4">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!window.confirm("Delete this thread?")) return;
                      deleteThread.mutate(thread.id);
                    }}
                    disabled={deleteThread.isPending}
                    className="text-[var(--mute)] hover:text-red-500 text-xs px-2 py-1 rounded transition-colors"
                    title="Delete thread"
                  >
                    ×
                  </button>
                  <span className="text-[var(--mute)] text-sm">→</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
