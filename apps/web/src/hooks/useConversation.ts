"use client";

import { useReducer, useEffect, useCallback, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Message } from "@/lib/api";
import { reducer, initialState } from "@/lib/conversation-reducer";

export function useConversation(
  threadId: string,
  initialRun: { runId: string; status: string } | null,
) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const qc = useQueryClient();
  const runId = state.run.id ?? initialRun?.runId ?? null;
  const runIdRef = useRef(runId);
  runIdRef.current = runId;

  // 1) history
  const history = useQuery({
    queryKey: ["history", threadId],
    queryFn: () => api.getMessages(threadId),
    staleTime: 0,
  });
  const prevHistoryData = useRef<typeof history.data>(undefined);
  useEffect(() => {
    if (history.data && history.data !== prevHistoryData.current) {
      prevHistoryData.current = history.data;
      dispatch({
        type: "history/loaded",
        messages: (history.data.messages ?? []) as Message[],
      });
    }
  }, [history.data]);

  // 1b) restore running state on page load
  const didInitRef = useRef(false);
  useEffect(() => {
    if (!didInitRef.current && initialRun?.runId) {
      didInitRef.current = true;
      dispatch({ type: "run/started", runId: initialRun.runId });
    }
  }, [initialRun?.runId]);

  // 2) /events (durable) — done is authoritative completion signal
  useEffect(() => {
    if (!runId) return;
    if (runId === runIdRef.current && runIdRef.current !== runId) return;

    const es = new EventSource(`/api/bff/runs/${runId}/events`);
    const seen = new Set<number>();

    const onEvent =
      (type: "message" | "interrupted" | "error") => (e: Event) => {
        if (!(e instanceof MessageEvent)) return;
        try {
          const seq = e.lastEventId
            ? parseInt(e.lastEventId, 10)
            : null;
          if (seq !== null) {
            if (seen.has(seq)) return;
            seen.add(seq);
          }
          const raw = JSON.parse(e.data as string) as {
            type: string;
            payload: unknown;
          };
          if (type === "message") {
            dispatch({
              type: "events/message",
              seq,
              msg: raw.payload as { role: string; content: unknown },
            });
          } else if (type === "interrupted") {
            dispatch({ type: "events/interrupted", payload: raw.payload as { pendingTool?: { id: string; name: string; input: unknown } } });
          } else {
            dispatch({
              type: "events/error",
              message:
                (raw.payload as { message?: string })?.message ?? "Unknown error",
            });
          }
        } catch {
          // skip malformed
        }
      };

    const handleDone = () => {
      dispatch({ type: "events/done" });
      es.close();
      qc.invalidateQueries({ queryKey: ["history", threadId] });
    };

    es.addEventListener("message", onEvent("message") as EventListener);
    es.addEventListener("interrupted", onEvent("interrupted") as EventListener);
    es.addEventListener("error", onEvent("error") as EventListener);
    es.addEventListener("done", handleDone);

    return () => {
      es.close();
    };
  }, [runId, threadId, qc]);

  // 3) /stream (ephemeral)
  useEffect(() => {
    if (!runId) return;

    const es = new EventSource(`/api/bff/runs/${runId}/stream`);

    es.addEventListener("text_delta", (e: Event) => {
      if (!(e instanceof MessageEvent)) return;
      try {
        const { blockIndex, text } = JSON.parse(e.data as string) as {
          blockIndex: number;
          text: string;
        };
        if (typeof text === "string") {
          dispatch({ type: "stream/delta", runId, blockIndex, text });
        }
      } catch {
        // skip
      }
    });

    es.addEventListener("tool_start", (e: Event) => {
      if (!(e instanceof MessageEvent)) return;
      try {
        const { id, name } = JSON.parse(e.data as string) as {
          id: string;
          name: string;
        };
        if (id && name) dispatch({ type: "stream/toolStart", id, name });
      } catch {
        // skip
      }
    });

    es.addEventListener("tool_end", (e: Event) => {
      if (!(e instanceof MessageEvent)) return;
      try {
        const { id } = JSON.parse(e.data as string) as { id: string };
        if (id) dispatch({ type: "stream/toolEnd", id });
      } catch {
        // skip
      }
    });

    return () => es.close();
  }, [runId]);

  // 4) currentRun poll — fallback for backend done
  const { data: currentRun } = useQuery({
    queryKey: ["currentRun", threadId],
    queryFn: () => api.getCurrentRun(threadId),
    refetchInterval: () => (state.run.phase === "running" ? 2000 : false),
  });
  useEffect(() => {
    if (state.run.phase === "running" && currentRun === null) {
      dispatch({ type: "run/completed" });
      qc.invalidateQueries({ queryKey: ["history", threadId] });
    }
  }, [currentRun, state.run.phase, threadId, qc]);

  // mutations
  const startRun = useMutation({
    mutationFn: (text: string) => api.startRun(threadId, text),
    onSuccess: (d) => {
      dispatch({ type: "run/started", runId: d.runId });
      qc.invalidateQueries({ queryKey: ["currentRun", threadId] });
    },
    onError: () => dispatch({ type: "run/error" }),
  });
  const resumeRun = useMutation({
    mutationFn: (v: { approved: boolean; message?: string }) =>
      api.resumeRun(runId!, v.approved, v.message),
    onSuccess: () => dispatch({ type: "run/started", runId: runId! }),
  });
  const cancelRun = useMutation({
    mutationFn: () => api.cancelRun(runId!),
  });

  const send = useCallback(
    (text: string) => {
      dispatch({ type: "send", text });
      startRun.mutate(text);
    },
    [startRun],
  );
  const approve = useCallback(
    (m?: string) => resumeRun.mutate({ approved: true, message: m }),
    [resumeRun],
  );
  const deny = useCallback(
    (m?: string) => resumeRun.mutate({ approved: false, message: m }),
    [resumeRun],
  );
  const cancel = useCallback(() => cancelRun.mutate(), [cancelRun]);

  return {
    messages: state.messages,
    draft: state.draft,
    phase: state.run.phase,
    busy: state.run.phase === "running" || (!!state.draft && state.run.phase !== "done"),
    pendingInterrupt: state.pendingInterrupt,
    error: state.error,
    runId,
    historyLoading: history.isLoading,
    send,
    approve,
    deny,
    cancel,
    canceling: cancelRun.isPending,
    resuming: resumeRun.isPending,
  };
}
