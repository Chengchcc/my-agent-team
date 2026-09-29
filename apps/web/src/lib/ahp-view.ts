/** Derives the timeline's transient view from AHP chat state (ADR 0040).
 *
 *  The transient pieces - the streaming bubble, live tool steps, the run's todo list - used to
 *  arrive on the run-event stream. They are all part of the chat state on the AHP side, so a
 *  surface that reads state does not need that stream at all. This is the pure half: state in,
 *  the view the components already take out, so it can be tested without a socket.
 *
 *  Approval and ask cards come from the same place: their durable payload rides in the input
 *  request's `_meta`, so the card can render what was asked without a second stream. */

import type { Message } from "@chengchenccc/message";
import type {
  Message as AhpMessage,
  ChatState,
  ResponsePart,
  ToolCallState,
} from "@microsoft/agent-host-protocol";
import type { SenderRef, UiItem } from "./conversation-reducer";
import {
  type LiveToolCall,
  type LiveToolMap,
  type TodoItem,
  type TransientMap,
  type TransientRun,
  toolKey,
} from "./transient-reducer";

export interface AhpChatView {
  readonly transients: TransientMap;
  readonly tools: LiveToolMap;
  /** The run's todo list, keyed the way the hook already keys it. */
  readonly todos: Record<string, TodoItem[]>;
}

export function chatViewFromState(state: ChatState, agentId: string): AhpChatView {
  const transients: TransientMap = {};
  const tools: LiveToolMap = {};
  // Only the turn in flight: a finished turn's text is the canonical message, which the timeline
  // already renders from the conversation list, and its steps are history, not live activity.
  const turns: Array<{ id: string; responseParts: readonly ResponsePart[] }> = state.activeTurn
    ? [state.activeTurn]
    : [];

  for (const turn of turns) {
    const run: TransientRun = { text: "", thinking: "", ordered: [], agentId };
    for (const part of turn.responseParts) {
      // Upstream's discriminant is a const enum: drop to a string before comparing.
      switch (part.kind as string) {
        case "markdown": {
          const text = contentOf(part);
          if (text) {
            run.text += text;
            run.ordered.push({ type: "text", text });
          }
          break;
        }
        case "reasoning": {
          const text = contentOf(part);
          if (text) {
            run.thinking += text;
            run.ordered.push({ type: "thinking", text });
          }
          break;
        }
        case "toolCall": {
          const call = (part as { toolCall: ToolCallState }).toolCall;
          const live: LiveToolCall = {
            runId: turn.id,
            callId: call.toolCallId,
            name: call.toolName,
            state: toolStateOf(call),
            ...(call.intention === undefined ? {} : { activity: call.intention }),
          };
          tools[toolKey(turn.id, call.toolCallId)] = live;
          break;
        }
        case "inputRequest": {
          const card = cardOf(part);
          if (card?.kind === "approval") run.approval = card.approval;
          else if (card) run.ask = card.ask;
          break;
        }
        case "error": {
          const message = (part as { error?: { message?: string } }).error?.message;
          if (message) run.error = message;
          break;
        }
        default:
          break;
      }
    }
    const hasCards = run.approval !== undefined || run.ask !== undefined;
    if (run.text !== "" || run.thinking !== "" || run.error !== undefined || hasCards) {
      transients[turn.id] = run;
    }
  }

  const todos = todosOf(state, transients);
  return { transients, tools, todos };
}

function toolStateOf(call: ToolCallState): LiveToolCall["state"] {
  const status = call.status as string;
  // `success` only exists on the completed variant, and the discriminant is a const enum.
  if (status === "completed") {
    return (call as { success?: boolean }).success === false ? "error" : "done";
  }
  if (status === "cancelled") return "error";
  return "running";
}

/** An input request as the timeline's cards need it: the durable payload carries what was asked
 *  (tool, reason, the argument being approved), and the request's own `message` says which card. */
function cardOf(
  part: ResponsePart,
):
  | { kind: "approval"; approval: NonNullable<TransientRun["approval"]> }
  | { kind: "ask"; ask: NonNullable<TransientRun["ask"]> }
  | undefined {
  const request = (part as { request?: RequestLike }).request;
  if (request === undefined) return undefined;
  const payload = request._meta?.productRequest as PayloadLike | undefined;
  const callId = typeof payload?.callId === "string" ? payload.callId : (request.id ?? "");
  if (request.message !== "approval") {
    return {
      kind: "ask",
      ask: { callId, questions: Array.isArray(payload?.questions) ? payload.questions : [] },
    };
  }
  return {
    kind: "approval",
    approval: {
      callId,
      toolName: typeof payload?.toolName === "string" ? payload.toolName : "",
      reason: typeof payload?.reason === "string" ? payload.reason : "",
      ...(typeof payload?.detail === "string" ? { detail: payload.detail } : {}),
      ...(typeof payload?.sandboxed === "boolean" ? { sandboxed: payload.sandboxed } : {}),
      ...(typeof payload?.deadlineAt === "number" ? { deadlineAt: payload.deadlineAt } : {}),
    },
  };
}

interface RequestLike {
  readonly id?: string;
  readonly message?: string;
  readonly _meta?: { readonly productRequest?: unknown };
}

interface PayloadLike {
  readonly callId?: unknown;
  readonly toolName?: unknown;
  readonly reason?: unknown;
  readonly detail?: unknown;
  readonly sandboxed?: unknown;
  readonly deadlineAt?: unknown;
  readonly questions?: unknown;
}

function contentOf(part: ResponsePart): string | undefined {
  const content = (part as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

/** The run's todo list rides in the chat's `_meta` (the projection puts it there); the hook keys
 *  todos by run, so it is filed under the active turn when there is one. */
function todosOf(state: ChatState, transients: TransientMap): Record<string, TodoItem[]> {
  const meta = (state as { _meta?: { todos?: unknown } })._meta;
  const list = meta?.todos;
  if (!Array.isArray(list)) return {};
  const runId = state.activeTurn?.id ?? Object.keys(transients).at(-1);
  return runId === undefined ? {} : { [runId]: list as TodoItem[] };
}

/** The timeline's message list, from AHP chat state.
 *
 *  Every turn but the one in flight is finished: its initiating message and its text are the
 *  conversation's history, and the coordinate in `_meta.seq` is what fork and undo address. The
 *  ids are the ledger's, so the viewer's optimistic echo of their own message collapses onto the
 *  same item instead of appearing twice. */
export function itemsFromChatState(
  state: ChatState,
  viewer: SenderRef,
  agent: SenderRef | null,
): UiItem[] {
  const items: UiItem[] = [];
  const turns: Array<{
    id: string;
    message: AhpMessage;
    responseParts: readonly ResponsePart[];
  }> = [...state.turns, ...(state.activeTurn ? [state.activeTurn] : [])];

  for (const turn of turns) {
    const input = messageItem(turn.message, viewer);
    if (input) items.push(input);
    // The turn in flight streams into the transient bubble; adding its text here would show the
    // same words twice. Its initiating message is real history and stays.
    if (turn.id === state.activeTurn?.id) continue;
    turn.responseParts.forEach((part, index) => {
      if ((part.kind as string) !== "markdown") return;
      const text = contentOf(part);
      if (!text) return;
      const meta = metaOfRequest(part);
      const id = typeof meta?.messageId === "string" ? meta.messageId : `${turn.id}:text:${index}`;
      items.push({
        kind: "message",
        id,
        sender: agent ?? { memberId: "agent", kind: "agent" },
        content: { role: "assistant", text } satisfies Message,
        // The coordinate the projection put on the part; a part without one came from no row.
        seq: typeof meta?.seq === "number" ? meta.seq : 0,
        ...(meta?.undone === true ? { undone: true } : {}),
      });
    });
  }
  return items;
}

function messageItem(message: AhpMessage, viewer: SenderRef): UiItem | undefined {
  if (message.text === "") return undefined;
  const meta = metaOfRequest({ _meta: (message as { _meta?: unknown })._meta } as never);
  const messageId = typeof meta?.messageId === "string" ? meta.messageId : undefined;
  const kind = message.origin?.kind as string;
  return {
    kind: "message",
    id: messageId ?? `input:${message.text.slice(0, 24)}`,
    sender: kind === "user" ? viewer : { memberId: "agent", kind: "agent" },
    content: { role: kind === "user" ? "user" : "assistant", text: message.text } satisfies Message,
    seq: typeof meta?.seq === "number" ? meta.seq : 0,
    ...(meta?.undone === true ? { undone: true } : {}),
  };
}

function metaOfRequest(
  part: unknown,
): { messageId?: unknown; seq?: unknown; undone?: unknown } | undefined {
  const meta = (part as { _meta?: unknown } | undefined)?._meta;
  return meta !== null && typeof meta === "object"
    ? (meta as { messageId?: unknown; seq?: unknown; undone?: unknown })
    : undefined;
}
