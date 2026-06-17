import type { Message, MessageState } from "./message.js";
import type { MessageRevision } from "./revision.js";

/** Build a messageId for a run's N-th assistant output.
 *  Ordinal distinguishes multiple assistant messages within the same run
 *  (e.g. pre-tool vs post-tool segments). Most runs produce exactly one
 *  assistant message (ordinal = 0). */
export function assistantMessageId(runId: string, ordinal: number): string {
  return `run:${runId}:assistant:${ordinal}`;
}

const OPEN_STATES: ReadonlySet<MessageState> = new Set(["pending", "streaming", "waiting"]);

/** Whether the state means the message is still open (not terminal). */
export function isOpenMessageState(state: MessageState): boolean {
  return OPEN_STATES.has(state);
}

const TERMINAL_STATES: ReadonlySet<MessageState> = new Set(["done", "error"]);

/** Whether the state means the message has reached a terminal state. */
export function isTerminalMessageState(state: MessageState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Apply a MessageRevision to a Message (upsert by messageId).
 *  Returns a new Message object. If `message` is null/undefined,
 *  creates a new Message from the revision. */
export function mergeMessageRevision(
  message: Message | null | undefined,
  revision: MessageRevision,
): Message {
  const base: Message = message ?? {
    id: revision.messageId,
    role: revision.role,
    createdAt: revision.updatedAt,
  };

  return {
    ...base,
    id: revision.messageId,
    role: revision.role,
    state: revision.state,
    text: revision.text ?? base.text,
    blocks: revision.blocks ?? base.blocks,
    tools: revision.tools ?? base.tools,
    runId: revision.runId ?? base.runId,
    conversationId: revision.conversationId ?? base.conversationId,
    visibility: revision.visibility ?? base.visibility,
    updatedAt: revision.updatedAt,
    error: revision.error ?? base.error,
  };
}
