import type { LarkMessageEvent } from "./event-parser.js";

/** Topic routing (ADR 0037): a backend conversation is one Lark TOPIC, not one
 *  chat. This module owns the pure half — which Lark objects identify a
 *  message's topic — so the rule can be tested without a database.
 *
 *  Measured shapes (live events, 2026-09-24):
 *   - topic chat, top-level message: `thread_id` set (its own topic), no root
 *   - topic chat, reply in that topic: same `thread_id`, `root_id` = the
 *     topic's first message
 *   - p2p, reply to one of OUR messages: no `thread_id`, `root_id` = our
 *     message id
 *   - p2p, the next reply in that chain: Lark has assigned a `thread_id` by
 *     then, and `root_id` still points at our message
 */

/** Keys that may already identify this message's topic, in lookup order.
 *  The thread id wins (it is the topic itself); `root_id` covers a topic we
 *  opened but whose thread id Lark had not assigned yet. */
export function topicLookupKeys(event: LarkMessageEvent): readonly string[] {
  const keys: string[] = [];
  if (event.thread_id) keys.push(event.thread_id);
  if (event.root_id) keys.push(event.root_id);
  return keys;
}

/** The message an answer must reply to in order to land inside this topic.
 *
 *  This is the topic's FIRST message — while we are already inside the topic
 *  it is `root_id`, otherwise it is our own message id, which opens the topic.
 *  Needed separately from the lookup keys because the reply API takes a
 *  MESSAGE id, while a topic-chat message may only tell us its thread id
 *  (`omt_…`) — replying to a thread id is not possible. */
export function topicRootMessageId(event: LarkMessageEvent): string {
  return event.root_id ?? event.message_id;
}

/** Does an answer have to be sent as a THREAD reply (which is what creates or
 *  joins a Lark topic)?
 *
 *  - topic chat ("topic"): required, otherwise the answer lands in the main
 *    stream instead of the conversation's topic;
 *  - p2p: NOT used. A thread reply here would turn a plain DM into a topic
 *    chat (`thread_id` comes back, the topic then exists for good), so every
 *    DM answer would sit in its own thread instead of the chat itself. The
 *    operator asked for the opposite (2026-11-19): DM stays flat, and only
 *    group topics get thread replies;
 *  - plain group: nothing to join;
 *  - unknown (`null`, a lookup that failed): flat. Threading is the choice
 *    that creates state (a topic that cannot be undone); the flat answer can
 *    be retried into a topic, a stray topic cannot. */
export function replyInThreadFor(chatMode: string | null): boolean {
  return chatMode === "topic";
}

/** Keys to remember for the conversation this message belongs to.
 *
 *  A message that carries topic context contributes that context (so a p2p
 *  reply chain learns the thread id Lark assigns only after the first reply).
 *  A message that carries NONE opens a topic, and then its own message id is
 *  the object a later reply points at via `root_id` — that is what makes
 *  "reply to keep talking" work in a p2p chat, where the topic root is one of
 *  our own messages. */
export function topicKeysToRemember(event: LarkMessageEvent): readonly string[] {
  const keys = new Set<string>(topicLookupKeys(event));
  // Always include the reply target: it is what lets a later answer land in
  // this topic, and what a later reply points at via `root_id`.
  keys.add(topicRootMessageId(event));
  return [...keys];
}
