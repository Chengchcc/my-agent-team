import type { Database } from "bun:sqlite";
import { ensureTopicRoot, getConversationBinding, rememberTopicKeys } from "./bindings-sqlite.js";
import { type LarkSendResult, sendViaLarkCli } from "./lark-send.js";
import { replyInThreadFor } from "./topic-routing.js";

/** Send one message into its conversation's topic (ADR 0037).
 *
 *  EVERY outbound path goes through here — bridge delivery, run-card fallback
 *  text, control replies — because "post to the chat" is not "post to the
 *  topic": in a TOPIC chat a top-level message OPENS A NEW TOPIC. A path that
 *  forgets its reply target therefore scatters one conversation across many
 *  topics instead of failing loudly, which is exactly what happened when only
 *  the control-reply path had been taught the target and every bridge delivery
 *  still went top level.
 *
 *  Where the message landed is registered as a topic key: the user can reply to
 *  THIS message, and its id is also what makes the send auditable (and, when a
 *  probe goes wrong, withdrawable). */
export async function sendIntoTopic(input: {
  db: Database;
  profile: string;
  chatId: string;
  conversationId: string;
  text: string;
  idempotencyKey?: string;
}): Promise<LarkSendResult> {
  const binding = getConversationBinding(input.db, input.conversationId);
  const result = await sendViaLarkCli({
    profile: input.profile,
    chatId: input.chatId,
    text: input.text,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    replyTo: ensureTopicRoot(input.db, input.chatId, input.conversationId),
    replyInThread: replyInThreadFor(binding?.chatMode ?? null),
  });
  if (result.ok && result.messageId) {
    const keys = result.threadId ? [result.messageId, result.threadId] : [result.messageId];
    rememberTopicKeys(input.db, input.chatId, input.conversationId, keys, Date.now());
  }
  return result;
}
