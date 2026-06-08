"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Message } from "@/lib/api";
import { useLiveEvents } from "./useLiveEvents";
import { messagesToTimeline, type TimelineItem } from "@/lib/timeline";
import { useEffect, useMemo, useRef } from "react";

export function useTimeline(
  threadId: string,
  currentRunId: string | null,
  optimistic?: string | null,
) {
  const queryClient = useQueryClient();
  const prevStatusRef = useRef<string | null>(null);

  const history = useQuery({
    queryKey: ["history", threadId],
    queryFn: () => api.getMessages(threadId),
    staleTime: 0,
  });

  const live = useLiveEvents(currentRunId);

  // Run done → invalidate history. Don't reset live until history refetches.
  useEffect(() => {
    const wasStreaming = prevStatusRef.current === "streaming";
    prevStatusRef.current = live.status;

    if (live.status === "done" && wasStreaming) {
      queryClient.invalidateQueries({ queryKey: ["history", threadId] });
    }
  }, [live.status, threadId, queryClient]);

  // When history finishes loading after a done event, clear live messages
  useEffect(() => {
    if (live.status === "done" && !history.isLoading && history.isSuccess) {
      // Small delay so the user sees the final streaming state
      const t = setTimeout(() => live.reset(), 300);
      return () => clearTimeout(t);
    }
  }, [live.status, history.isLoading, history.isSuccess, live.reset]);

  const items = useMemo(() => {
    const historyMsgs = (history.data?.messages as Message[]) ?? [];
    const historyItems = messagesToTimeline(historyMsgs);

    // Optimistic user message (shown immediately before SSE confirms it)
    const lead: TimelineItem[] = optimistic
      ? [{ kind: "message" as const, role: "user" as const, content: optimistic }]
      : [];

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
          seq: rec.seq,
        });
      }
    }

    return [...historyItems, ...lead, ...liveItems];
  }, [history.data, live.messages, optimistic]);

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
