"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

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

  // Only show agent_thread kind, hide conversation threads
  const agentThreads = (threads ?? []).filter(
    (t) => t.kind === "agent_thread",
  );

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {agentThreads.length} thread(s)
        </p>
        <Button
          onClick={() => createThread.mutate()}
          disabled={createThread.isPending}
        >
          New Thread
        </Button>
      </div>
      {agentThreads.length === 0 ? (
        <p className="text-muted-foreground py-8 text-center">
          No threads yet. Create one to start chatting.
        </p>
      ) : (
        <div className="space-y-2">
          {agentThreads.map((thread) => (
            <Card
              key={thread.id}
              className="cursor-pointer hover:shadow-sm transition-shadow"
              onClick={() => router.push(`/threads/${thread.id}`)}
            >
              <CardHeader>
                <CardTitle className="text-base">
                  {thread.title ?? "Untitled Thread"}
                </CardTitle>
                <CardDescription className="text-xs">
                  Created {new Date(thread.createdAt).toLocaleDateString()}
                  {thread.lastRunAt &&
                    ` · Last run ${new Date(thread.lastRunAt).toLocaleDateString()}`}
                </CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
