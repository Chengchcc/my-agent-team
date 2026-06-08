"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useRouter } from "next/navigation";

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

  const agentThreads = (threads ?? []).filter(
    (t) => t.kind === "agent_thread",
  );

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <div key={i} className="border border-[var(--border-color)] p-6 animate-pulse">
            <div className="h-4 w-40 bg-[var(--warm-gray)] mb-2" />
            <div className="h-3 w-24 bg-[var(--warm-gray)]" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="font-[family-name:var(--font-mono)] text-[10px] tracking-[0.15em] uppercase text-[var(--warm-gray-dark)]">
          {agentThreads.length} thread{agentThreads.length !== 1 ? "s" : ""}
        </p>
        <button
          type="button"
          onClick={() => createThread.mutate()}
          disabled={createThread.isPending}
          className="border border-[var(--charcoal)] px-4 py-2 font-[family-name:var(--font-mono)]
                     text-[10px] tracking-[0.15em] uppercase text-[var(--charcoal)]
                     hover:bg-[var(--charcoal)] hover:text-[var(--cream)]
                     disabled:opacity-40 disabled:cursor-not-allowed
                     transition-colors duration-300"
        >
          + New Thread
        </button>
      </div>

      {agentThreads.length === 0 ? (
        <div className="py-16 text-center border border-[var(--border-color)]">
          <p className="font-[family-name:var(--font-heading)] text-sm text-[var(--warm-gray-dark)]">
            No threads yet
          </p>
          <p className="font-[family-name:var(--font-mono)] text-[9px] text-[var(--warm-gray-dark)] mt-1">
            Create one to start working with this agent
          </p>
        </div>
      ) : (
        <div className="space-y-0.5">
          {agentThreads.map((thread, i) => (
            <button
              key={thread.id}
              type="button"
              onClick={() => router.push(`/threads/${thread.id}`)}
              className="w-full text-left border border-[var(--border-color)]
                         hover:border-[var(--brass)] transition-colors duration-200
                         animate-fade-in"
              style={{
                animationDelay: `${i * 0.06}s`,
                animationFillMode: "both",
              }}
            >
              <div className="px-6 py-5 flex items-center justify-between">
                <div>
                  <h3 className="font-[family-name:var(--font-heading)] text-base font-medium text-[var(--charcoal)]">
                    {thread.title ?? "Untitled Thread"}
                  </h3>
                  <p className="font-[family-name:var(--font-mono)] text-[9px] tracking-[0.15em] text-[var(--warm-gray-dark)] mt-1">
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
                <span className="text-[var(--warm-gray-dark)] text-sm">→</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
