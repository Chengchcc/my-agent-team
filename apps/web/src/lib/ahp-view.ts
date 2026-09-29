/** Derives the timeline's transient view from AHP chat state (ADR 0040).
 *
 *  The transient pieces - the streaming bubble, live tool steps, the run's todo list - used to
 *  arrive on the run-event stream. They are all part of the chat state on the AHP side, so a
 *  surface that reads state does not need that stream at all. This is the pure half: state in,
 *  the view the components already take out, so it can be tested without a socket.
 *
 *  Approval and ask cards are deliberately not derived here yet: their payload shape is its own
 *  step, and nothing switches onto this module until it covers what the surface renders. */
import type { ChatState, ResponsePart, ToolCallState } from "@microsoft/agent-host-protocol";
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
  const turns: Array<{ id: string; responseParts: readonly ResponsePart[] }> = [
    ...state.turns,
    ...(state.activeTurn ? [state.activeTurn] : []),
  ];

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
        case "error": {
          const message = (part as { error?: { message?: string } }).error?.message;
          if (message) run.error = message;
          break;
        }
        default:
          break;
      }
    }
    if (run.text !== "" || run.thinking !== "" || run.error !== undefined) {
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
