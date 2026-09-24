import type { LarkMessageEvent } from "@chengchenccc/api-contract";
import { larkMessageEventSchema } from "@chengchenccc/api-contract";

export type { LarkMessageEvent };

/**
 * Parse a Lark NDJSON event line using the shared zod schema (single source).
 * Replaces the old hand-rolled narrow with safeParse.
 */
export function parseEvent(line: string): LarkMessageEvent | null {
  try {
    const raw = JSON.parse(line);
    const result = larkMessageEventSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** The `@everyone` placeholder key lark-cli emits in the mentions array. */
const MENTION_ALL_KEY = "@_all";

/** Whether the bot was actually @-mentioned.
 *
 *  Reads the structured `mentions` array, NOT the rendered text. lark-cli
 *  pre-renders `.content` to human-readable text with mentions resolved to
 *  display names, so a member typing "@backend-agent" by hand produces the
 *  same text as a real mention — while only a real mention produces an entry
 *  in `mentions`. Matching the text made the bot answer to strings anyone
 *  could type.
 *
 *  `@everyone` is an explicit entry of its own and is never a mention of the
 *  bot; whether it should trigger is a policy decision (see the group gate).
 *
 *  Matching is by display name because the bot's own open_id is not recorded
 *  anywhere yet; once the setup flow stores it, this should compare `id`
 *  (lark-cli gives the mentioned open_id in each entry). */
export function isBotMentioned(event: LarkMessageEvent, botDisplayName: string | null): boolean {
  if (!botDisplayName) return false;
  const wanted = botDisplayName.trim().toLowerCase();
  if (wanted.length === 0) return false;
  return (event.mentions ?? []).some(
    (m) => m.key !== MENTION_ALL_KEY && m.name.trim().toLowerCase() === wanted,
  );
}

/** Whether the message @-mentioned everyone in the chat. */
export function isMentionAll(event: LarkMessageEvent): boolean {
  return (event.mentions ?? []).some((m) => m.key === MENTION_ALL_KEY);
}
