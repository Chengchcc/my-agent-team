"use client";

import { conversationEvents } from "@my-agent-team/api-contract";
import { useCallback, useEffect, useReducer } from "react";
import { toast } from "sonner";
import {
  useConversationSnapshot,
  usePostConversationMessage,
  useResumeRun,
} from "@/features/conversations/hooks";
import type { ConversationSnapshot } from "@/lib/api";
import {
  type ConvState,
  getApprovalTarget,
  initialState,
  isBusy,
  reducer,
  type SenderRef,
} from "@/lib/conversation-reducer";
import { typedSource } from "@/lib/typed-source";

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

  // 1) Snapshot bootstrap (roster + viewerMemberId)
  const snap = useConversationSnapshot(conversationId, preFetchedSnapshot);
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

  // 2) Conversation event stream — sole message input for Web surface.
  //    No more run EventSource; all message output arrives via the conversation SSE.
  useEffect(() => {
    if (!conversationId) return;
    const ts = typedSource(
      `/api/bff/api/conversations/${conversationId}/events`,
      conversationEvents,
      {
        onError: (_event, _err) => {
          /* skip malformed entries */
        },
      },
    );
    let wasDisconnected = false;
    // W4/W6: reconnected toast only shown when actual gap is detected + recovered
    let pendingGap = false;

    ts.es.onopen = () => {
      dispatch({ type: "conn", status: "open" });
      if (wasDisconnected) {
        pendingGap = true;
        wasDisconnected = false;
      }
    };

    ts.es.onerror = () => {
      const status = ts.es.readyState === EventSource.CLOSED ? "closed" : "reconnecting";
      dispatch({ type: "conn", status });
      if (status === "reconnecting") wasDisconnected = true;
    };

    // W6: bounded dedup — waterline + sliding window
    let lastAppliedSeq = 0;
    const seen = new Set<number>();
    const GUARD_WINDOW = 256;
    const guard = (entry: { seq: number }): number | null => {
      const seq = entry.seq;
      if (!Number.isFinite(seq)) return seq;
      if (seq <= lastAppliedSeq) return null;
      seen.add(seq);
      if (seen.size > GUARD_WINDOW) {
        const sorted = [...seen].sort((a: number, b: number) => a - b);
        const cutoff = sorted[sorted.length - GUARD_WINDOW]!;
        for (const s of sorted) if (s <= cutoff) seen.delete(s);
      }
      lastAppliedSeq = Math.max(lastAppliedSeq, seq);
      if (pendingGap) {
        // Hole detected on reconnect — notify user
        toast.success("Reconnected — syncing missed messages");
        pendingGap = false;
      }
      return seq;
    };

    ts.on("message", (entry) => {
      const seq = guard(entry);
      if (seq === null) return;
      const content = typeof entry.content === "string" ? safeParse(entry.content) : entry.content;
      if (entry.senderMemberId === "__system__") {
        dispatch({
          type: "member",
          seq,
          kind: "member.joined",
          payload: content,
        });
      } else {
        dispatch({
          type: "message",
          seq,
          senderMemberId: entry.senderMemberId,
          content,
        });
      }
    });

    ts.on("member.joined", (entry) => {
      const seq = guard(entry);
      if (seq === null) return;
      const payload = typeof entry.content === "string" ? safeParse(entry.content) : entry.content;
      dispatch({ type: "member", seq, kind: "member.joined", payload });
    });

    ts.on("member.left", (entry) => {
      const seq = guard(entry);
      if (seq === null) return;
      const payload = typeof entry.content === "string" ? safeParse(entry.content) : entry.content;
      dispatch({ type: "member", seq, kind: "member.left", payload });
    });

    ts.on("todo", (entry) => {
      const payload = typeof entry.content === "string" ? safeParse(entry.content) : entry.content;
      const todos =
        payload && typeof payload === "object" && "todos" in payload
          ? (payload as { todos: ConvState["todos"] }).todos
          : null;
      if (Array.isArray(todos)) {
        dispatch({ type: "todo/update", todos });
      }
    });

    return () => ts.close();
  }, [conversationId]);

  // 3) Send: optimistic dispatch + POST /conversations/:id/messages.
  //    The conversation SSE delivers the authoritative ledger revision which
  //    upserts the optimistic message by messageId. No run EventSource needed.
  const sendMut = usePostConversationMessage(conversationId);

  const send = useCallback(
    (text: string, addressedTo?: string[]) => {
      const viewer = state.roster[state.viewerMemberId] ?? {
        memberId: state.viewerMemberId,
        kind: "human" as const,
      };
      const resolved = addressedTo ?? [];
      dispatch({ type: "send", text, viewer });
      sendMut.mutate(
        {
          senderMemberId: state.viewerMemberId,
          text,
          addressedTo: resolved.length > 0 ? resolved : resolveAddressedTo(state),
        },
        { onError: () => dispatch({ type: "send/error", message: "Send failed — retry" }) },
      );
    },
    [sendMut, state.roster, state.viewerMemberId, state],
  );

  const toggleTriggerMode = useCallback(() => {
    dispatch({ type: "toggleTriggerMode" });
  }, []);

  const busy = isBusy(state);
  const approvalTarget = getApprovalTarget(state);

  // M17: Ledger-native approval via run resume API (not run EventSource)
  const approveMut = useResumeRun();

  const approve = useCallback(
    (message?: string) =>
      approveMut.mutate({ runId: approvalTarget!.runId, approved: true, message }),
    [approveMut, approvalTarget],
  );
  const deny = useCallback(
    (message?: string) =>
      approveMut.mutate({ runId: approvalTarget!.runId, approved: false, message }),
    [approveMut, approvalTarget],
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
