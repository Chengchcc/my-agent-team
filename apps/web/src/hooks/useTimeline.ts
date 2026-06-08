"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Message } from "@/lib/api";
import { useLiveEvents } from "./useLiveEvents";
import { messagesToTimeline, type TimelineItem } from "@/lib/timeline";
import { useEffect, useMemo } from "react";

export function useTimeline(
  threadId: string,
  currentRunId: string | null,
) {
  const queryClient = useQueryClient();

  const history = useQuery({
    queryKey: ["history", threadId],
    queryFn: () => api.getMessages(threadId),
    staleTime: 0,
  });

  const live = useLiveEvents(currentRunId);

  // Run done → invalidate history → refetch checkpoint
  useEffect(() => {
    if (live.status === "done") {
      queryClient.invalidateQueries({ queryKey: ["history", threadId] });
      live.reset();
    }
  }, [live.status, threadId, queryClient, live.reset]);

  const items = useMemo(() => {
    const historyMsgs = (history.data?.messages as Message[]) ?? [];
    const historyItems = messagesToTimeline(historyMsgs);

    const liveItems: TimelineItem[] = [];
    for (const rec of live.messages) {
      if (rec.event.type === "message") {
        const payload = rec.event.payload as {
          role: string;
          content: unknown;
        };
        liveItems.push({
          kind: "message" as const,
          role: payload.role as "user" | "assistant",
          content: payload.content as string | unknown[],
        });
      }
    }

    return [...historyItems, ...liveItems];
  }, [history.data, live.messages]);

  const liveAssistantIndex = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.role === "assistant") return i;
    }
    return -1;
  }, [items]);

  return {
    items,
    liveAssistantIndex,
    isStreamingDone: live.status === "done" || live.status === "idle",
    liveStatus: live.status,
    liveMessages: live.messages,
    liveReset: live.reset,
    historyLoading: history.isLoading,
  };
}
