"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ChatModelOverride } from "@/components/ModelPicker";
import { useAgentList } from "@/features/agents/hooks";
import {
  useConversationMembers,
  useConversationSnapshot,
  usePostConversationMessage,
} from "@/features/conversations/hooks";
import { parseMentions } from "@/features/conversations/mentions";
import { connectAhpChat } from "@/lib/ahp";
import type { ConversationSnapshot } from "@/lib/api";
import { api } from "@/lib/api";
import { activeTurnFromState, itemsFromChatState } from "@/lib/chat-state";
import { initialState, isBusy, reducer } from "@/lib/conversation-reducer";
import {
  clearTransientApproval,
  type LiveToolMap,
  markTransientApprovalError,
  type RunTodoMap,
  type TransientMap,
} from "@/lib/transient-reducer";

export function useConversation(
  conversationId: string,
  preFetchedSnapshot?: ConversationSnapshot | null,
) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  /** Transient streaming output per active run (one bubble per run in the
   *  Timeline). Never persisted; each entry is replaced by the canonical
   *  final Message (`run:<runId>:assistant:0`) or dropped on failure. */
  const [transients, setTransients] = useState<TransientMap>({});
  const transientsRef = useRef(transients);

  /** Live tool steps per run (`<runId>:<callId>` key). Run-local, transient:
   *  never written to History, cleared at run terminal. */
  const [transientTools, setTransientTools] = useState<LiveToolMap>({});
  /** Latest todo snapshot per run (todo_write replaces the whole list). */
  const [runTodos, setRunTodos] = useState<RunTodoMap>({});
  /** The run the chat state says is live: the projection builds one active turn per running Run,
   *  so the id comes from there and not from a stream of its own. */
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  // Leaving the conversation clears its transient state: a switched conversation must never
  // inherit the previous one's streaming bubbles. Runs on unmount AND conversationId change;
  // setState calls after unmount are no-ops in React 18+.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cleanup-only effect keyed on conversationId
  useEffect(() => {
    return () => {
      setTransients({});
      transientsRef.current = {};
      setTransientTools({});
      setRunTodos({});
    };
  }, [conversationId]);
  /** HITL approval (spec): POST the decision; clear the card ONLY on a
   *  successful response. A failed POST means the child never saw the
   *  decision — dropping the card would silently lose a live approval. */
  const resolveApproval = useCallback(
    async (runId: string, callId: string, decision: "allow" | "deny") => {
      try {
        await api.resolveApproval(runId, callId, decision);
      } catch (err) {
        console.error("approval resolve failed:", err);
        setTransients((prev) => {
          const next = markTransientApprovalError(
            prev,
            runId,
            err instanceof Error ? err.message : "resolve failed — retry",
          );
          transientsRef.current = next;
          return next;
        });
        return;
      }
      setTransients((prev) => {
        const next = clearTransientApproval(prev, runId);
        transientsRef.current = next;
        return next;
      });
    },
    [],
  );
  // 1) Snapshot bootstrap (the conversation's agent)
  const snap = useConversationSnapshot(conversationId, preFetchedSnapshot);

  /** Live chat state comes from the AHP face (ADR 0040). It carries everything the run-event
   *  stream used to: streaming text and thinking, live tool steps, the run's todo list, the HITL
   *  cards, and which run is live. The stream is gone; this is the only live source. */
  useEffect(() => {
    const agentId = snap.data?.agentId;
    if (!conversationId || !agentId) return;
    const connection = connectAhpChat({
      conversationId,
      clientId: `web:${conversationId}`,
      onChange: (state) => {
        const view = activeTurnFromState(state, agentId);
        setTransients(view.transients);
        transientsRef.current = view.transients;
        setTransientTools(view.tools);
        setRunTodos(view.todos);
        setActiveRunId(state.activeTurn?.id ?? null);
        // The history comes from the same subscription: a snapshot carries all of it, and every
        // later action keeps it current.
        dispatch({
          type: "items",
          items: itemsFromChatState(
            state,
            { memberId: "user", kind: "human" },
            { memberId: agentId, kind: "agent", agentId },
          ),
        });
        dispatch({ type: "conn", status: "open" });
      },
      onError: () => dispatch({ type: "conn", status: "reconnecting" }),
    });
    return () => connection.close();
  }, [conversationId, snap.data?.agentId]);
  useEffect(() => {
    if (!snap.data) return;
    dispatch({
      type: "bootstrap",
      agent: {
        memberId: snap.data.agentId ?? "agent",
        kind: "agent",
        agentId: snap.data.agentId ?? undefined,
      },
    });
  }, [snap.data]);

  // 3) Send: optimistic dispatch + POST /conversations/:id/messages.
  //    The AHP chat channel delivers the committed turn, whose message carries the
  //    ledger's messageId, so the optimistic item collapses onto it.
  const sendMut = usePostConversationMessage(conversationId);
  // ADR 0041: @mentions in the composed text direct routing in rooms; in a
  // 1:1 conversation they are inert (auto-routing already targets the member).
  const { data: memberData } = useConversationMembers(conversationId);
  const memberIds = useMemo(() => memberData?.members ?? [], [memberData]);
  const { data: agentsData } = useAgentList();
  const agentsRoster = useMemo(() => agentsData ?? [], [agentsData]);

  const send = useCallback(
    (
      text: string,
      model?: ChatModelOverride,
      attachments?: readonly { type: "image"; mediaType: string; base64: string }[],
    ) => {
      dispatch({
        type: "send",
        text,
        viewer: { memberId: "user", kind: "human" },
      });
      // While a run is live, messages queue for after it settles (the
      // Composer queue area) instead of being injected as a live steer;
      // each queued item can be steered/edited/cancelled individually.
      const queued = isBusy(state) || activeRunId !== null;
      sendMut.mutate(
        {
          text,
          mode: queued ? "follow_up" : undefined,
          model,
          attachments,
          addressedTo:
            memberIds.length > 1 && agentsRoster.length > 0
              ? parseMentions(
                  text,
                  agentsRoster
                    .filter((a) => memberIds.includes(a.id))
                    .map((a) => ({ agentId: a.id, displayName: a.name })),
                )
              : undefined,
        },
        {
          onSettled: () => {
            dispatch({ type: "send/settled" });
          },
          onError: () => {
            dispatch({ type: "send/error", message: "Send failed — retry" });
          },
        },
      );
    },
    [sendMut, state, activeRunId, memberIds, agentsRoster],
  );

  const busy = isBusy(state) || activeRunId !== null;

  return {
    state,
    busy,
    send,
    activeRunId,
    transients,
    transientTools,
    runTodos,
    resolveApproval,
  };
}
