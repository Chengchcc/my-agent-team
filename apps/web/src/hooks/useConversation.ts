"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer } from "react";
import { api, type ConversationSnapshot } from "@/lib/api";
import { type ConvState, initialState, reducer, type SenderRef } from "@/lib/conversation-reducer";

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function resolveViewerMemberId(members: SenderRef[]): string {
  const humans = members.filter((m) => m.kind === "human");
  return humans[0]?.memberId ?? "";
}

function resolveAddressedTo(s: ConvState): string[] {
  const agents = Object.values(s.roster).filter((m) => m.kind === "agent");
  if (agents.length === 0) return [];
  // "auto" mode: broadcast to all agents (no @ needed)
  // "mention" mode: must explicitly @mention
  if (s.triggerMode === "auto") return agents.map((m) => m.memberId);
  return [];
}

export function useConversation(
  conversationId: string,
  preFetchedSnapshot?: ConversationSnapshot | null,
) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const _qc = useQueryClient();

  // 1) Snapshot bootstrap (roster + viewerMemberId)
  const snap = useQuery({
    queryKey: ["conv", conversationId],
    queryFn: () => api.getConversation(conversationId),
    initialData: preFetchedSnapshot ?? undefined,
  });
  useEffect(() => {
    if (!snap.data) return;
    const members: SenderRef[] = snap.data.members.map((m) => ({
      memberId: m.memberId,
      kind: m.kind,
      displayName: m.displayName ?? undefined,
    }));
    const viewerMemberId = resolveViewerMemberId(members);
    dispatch({ type: "bootstrap", viewerMemberId, members });
  }, [snap.data]);

  // 2) Conversation ledger SSE (messages + member events + system notices)
  useEffect(() => {
    if (!conversationId) return;
    const es = new EventSource(`/api/bff/conversations/${conversationId}/events`);
    const seen = new Set<number>();

    const guard = (e: MessageEvent): number | null => {
      const seq = parseInt(e.lastEventId, 10);
      if (Number.isFinite(seq)) {
        if (seen.has(seq)) return null;
        seen.add(seq);
      }
      return seq;
    };

    // "message" event — regular chat messages
    es.addEventListener("message", (e: Event) => {
      if (!(e instanceof MessageEvent)) return;
      const seq = guard(e);
      if (seq === null) return;
      try {
        const entry = JSON.parse(e.data) as {
          senderMemberId: string;
          content: string;
        };
        const content =
          typeof entry.content === "string" ? safeParse(entry.content) : entry.content;
        if (entry.senderMemberId === "__system__") {
          dispatch({
            type: "ledger/member",
            seq,
            kind: "member.joined",
            payload: content,
          });
        } else {
          dispatch({
            type: "ledger/message",
            seq,
            senderMemberId: entry.senderMemberId,
            content,
          });
        }
      } catch {
        // skip malformed
      }
    });

    // "member.joined" / "member.left" — dedicated event types
    for (const kind of ["member.joined", "member.left"] as const) {
      es.addEventListener(kind, (e: Event) => {
        if (!(e instanceof MessageEvent)) return;
        const seq = guard(e);
        if (seq === null) return;
        try {
          const entry = JSON.parse(e.data) as { content: string };
          const payload =
            typeof entry.content === "string" ? safeParse(entry.content) : entry.content;
          dispatch({ type: "ledger/member", seq, kind, payload });
        } catch {
          // skip malformed
        }
      });
    }

    // M14.6: "todo" — plan progress snapshots, UI-only via ledger
    es.addEventListener("todo", (e: Event) => {
      if (!(e instanceof MessageEvent)) return;
      try {
        const entry = JSON.parse(e.data) as { content: string };
        const payload =
          typeof entry.content === "string" ? safeParse(entry.content) : entry.content;
        const todos =
          payload && typeof payload === "object" && "todos" in payload
            ? (payload as { todos: ConvState["todos"] }).todos
            : null;
        if (Array.isArray(todos)) {
          dispatch({ type: "todo/update", todos });
        }
      } catch {
        // skip
      }
    });

    return () => es.close();
  }, [conversationId]);

  // 3) Run-level token/tool stream: only when there's an active run
  useEffect(() => {
    const runId = state.run.id;
    if (!runId || state.run.phase !== "running") return;
    const agentMemberId = state.run.agentMemberId ?? "";

    const es = new EventSource(`/api/bff/runs/${runId}/stream`);

    es.addEventListener("text_delta", (e: Event) => {
      if (!(e instanceof MessageEvent)) return;
      try {
        const { blockIndex, text } = JSON.parse(e.data) as {
          blockIndex: number;
          text: string;
        };
        if (typeof text === "string") {
          dispatch({
            type: "stream/delta",
            runId,
            agentMemberId,
            blockIndex,
            text,
          });
        }
      } catch {
        // skip
      }
    });

    es.addEventListener("tool_start", (e: Event) => {
      if (!(e instanceof MessageEvent)) return;
      try {
        const { id, name } = JSON.parse(e.data) as {
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
        const { id } = JSON.parse(e.data) as { id: string };
        if (id) dispatch({ type: "stream/toolEnd", id });
      } catch {
        // skip
      }
    });

    return () => es.close();
  }, [state.run.id, state.run.phase, state.run.agentMemberId]);

  // 3b) /runs/:id/events (durable) — done/interrupted/error fallback
  useEffect(() => {
    const runId = state.run.id;
    if (!runId || state.run.phase !== "running") return;

    const es = new EventSource(`/api/bff/runs/${runId}/events`);

    const handleDone = () => {
      dispatch({ type: "run/done" });
      es.close();
    };

    es.addEventListener("done", handleDone);

    es.addEventListener("interrupted", (e: Event) => {
      if (!(e instanceof MessageEvent)) return;
      try {
        const raw = JSON.parse(e.data) as {
          type: string;
          payload: unknown;
        };
        dispatch({
          type: "run/interrupted",
          payload: raw.payload as {
            pendingTool?: { id: string; name: string; input: unknown };
          },
        });
      } catch {
        // skip
      }
    });

    // M14.6: todo_update events — durable channel, survives refresh
    es.addEventListener("todo_update", (e: Event) => {
      if (!(e instanceof MessageEvent)) return;
      try {
        const raw = JSON.parse(e.data) as {
          payload: { todos: ConvState["todos"] };
        };
        if (Array.isArray(raw.payload?.todos)) {
          dispatch({ type: "todo/update", todos: raw.payload.todos });
        }
      } catch {
        // skip
      }
    });

    return () => es.close();
  }, [state.run.id, state.run.phase]);

  // 4) Send: optimistic dispatch + POST /conversations/:id/messages
  const sendMut = useMutation({
    mutationFn: ({ text, addressedTo }: { text: string; addressedTo: string[] }) =>
      api.postConversationMessage(conversationId, {
        senderMemberId: state.viewerMemberId,
        addressedTo: addressedTo.length > 0 ? addressedTo : resolveAddressedTo(state),
        content: text,
      }),
    onSuccess: (d) => {
      const tr = d.triggeredRuns[0];
      if (tr) {
        dispatch({
          type: "run/started",
          runId: tr.runId,
          agentMemberId: tr.agentMemberId,
        });
      }
    },
    onError: () => dispatch({ type: "run/error", message: "发送失败" }),
  });

  const send = useCallback(
    (text: string, addressedTo?: string[]) => {
      const viewer = state.roster[state.viewerMemberId] ?? {
        memberId: state.viewerMemberId,
        kind: "human" as const,
      };
      dispatch({ type: "send", text, viewer });
      sendMut.mutate({ text, addressedTo: addressedTo ?? [] });
    },
    [sendMut, state.roster, state.viewerMemberId],
  );

  // Resume / cancel still per runId (run-level interrupt, ledger doesn't cover)
  const resumeRun = useMutation({
    mutationFn: (v: { approved: boolean; message?: string }) =>
      api.resumeRun(state.run.id!, v.approved, v.message),
    onSuccess: () => {
      if (state.run.id && state.run.agentMemberId) {
        dispatch({
          type: "run/started",
          runId: state.run.id,
          agentMemberId: state.run.agentMemberId,
        });
      }
    },
  });
  const cancelRun = useMutation({
    mutationFn: () => api.cancelRun(state.run.id!),
  });

  const approve = useCallback(
    (m?: string) => resumeRun.mutate({ approved: true, message: m }),
    [resumeRun],
  );
  const deny = useCallback(
    (m?: string) => resumeRun.mutate({ approved: false, message: m }),
    [resumeRun],
  );
  const cancel = useCallback(() => cancelRun.mutate(), [cancelRun]);

  const toggleTriggerMode = useCallback(() => dispatch({ type: "toggleTriggerMode" }), []);

  return {
    viewerMemberId: state.viewerMemberId,
    roster: state.roster,
    messages: state.messages,
    draft: state.draft,
    phase: state.run.phase,
    busy: state.run.phase === "running" || (!!state.draft && state.run.phase !== "done"),
    pendingInterrupt: state.pendingInterrupt,
    error: state.error,
    runId: state.run.id,
    loading: snap.isLoading,
    triggerMode: state.triggerMode,
    toggleTriggerMode,
    send,
    approve,
    deny,
    cancel,
    canceling: cancelRun.isPending,
    resuming: resumeRun.isPending,
    todos: state.todos,
  };
}
