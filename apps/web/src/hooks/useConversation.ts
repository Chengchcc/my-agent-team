"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer } from "react";
import { toast } from "sonner";
import { api, type ConversationSnapshot } from "@/lib/api";
import {
  type ConvState,
  getApprovalTarget,
  initialState,
  isBusy,
  reducer,
  type SenderRef,
} from "@/lib/conversation-reducer";

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

  // 2) Conversation ledger SSE — sole message input for Web surface.
  //    No more run EventSource; all message output arrives via ledger revisions.
  useEffect(() => {
    if (!conversationId) return;
    const es = new EventSource(`/api/bff/conversations/${conversationId}/events`);
    const seen = new Set<number>();
    let wasDisconnected = false;

    es.onopen = () => {
      dispatch({ type: "ledger/conn", status: "open" });
      if (wasDisconnected) {
        toast.success("Reconnected — missed messages restored");
        wasDisconnected = false;
      }
    };

    es.onerror = () => {
      const status = es.readyState === EventSource.CLOSED ? "closed" : "reconnecting";
      dispatch({ type: "ledger/conn", status });
      if (status === "reconnecting") wasDisconnected = true;
    };

    const guard = (e: MessageEvent): number | null => {
      const seq = parseInt(e.lastEventId, 10);
      if (Number.isFinite(seq)) {
        if (seen.has(seq)) return null;
        seen.add(seq);
      }
      return seq;
    };

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
        /* skip */
      }
    });

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
          /* skip */
        }
      });
    }

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
        /* skip */
      }
    });

    return () => es.close();
  }, [conversationId]);

  // 3) Send: optimistic dispatch + POST /conversations/:id/messages.
  //    The conversation SSE delivers the authoritative ledger revision which
  //    upserts the optimistic message by messageId. No run EventSource needed.
  const sendMut = useMutation({
    mutationFn: ({ text, addressedTo }: { text: string; addressedTo: string[] }) =>
      api.postConversationMessage(conversationId, {
        senderMemberId: state.viewerMemberId,
        addressedTo: addressedTo.length > 0 ? addressedTo : resolveAddressedTo(state),
        content: text,
      }),
    onError: () => dispatch({ type: "send/error", message: "Send failed — retry" }),
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

  const toggleTriggerMode = useCallback(() => {
    dispatch({ type: "toggleTriggerMode" });
  }, []);

  const busy = isBusy(state);
  const approvalTarget = getApprovalTarget(state);

  // M17: Ledger-native approval via run resume API (not run EventSource)
  const approveMut = useMutation({
    mutationFn: (v: { approved: boolean; message?: string }) =>
      api.resumeRun(approvalTarget!.runId, v.approved, v.message),
  });

  const approve = useCallback(
    (message?: string) => approveMut.mutate({ approved: true, message }),
    [approveMut],
  );
  const deny = useCallback(
    (message?: string) => approveMut.mutate({ approved: false, message }),
    [approveMut],
  );

  return {
    state,
    busy,
    send,
    toggleTriggerMode,
    approvalTarget,
    approve,
    deny,
    resuming: approveMut.isPending,
  };
}
