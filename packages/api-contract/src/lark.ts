import { z } from "zod";

/** Shared schema for lark→backend message content.
 *
 *  Single source — lark-bot writes, backend validates, both import.
 *  Changing a field name here → tsc fails on both sides. */
export const larkContentSchema = z.object({
  text: z.string(),
  source: z.literal("lark"),
  larkEventId: z.string().min(1),
  larkMessageId: z.string().min(1),
});

export type LarkContent = z.infer<typeof larkContentSchema>;

/** Shared schema for LarkMessageEvent (lark-cli NDJSON event). */
export const larkMessageEventSchema = z.object({
  type: z.string(),
  event_id: z.string().min(1),
  timestamp: z.string(),
  id: z.string(),
  message_id: z.string().min(1),
  create_time: z.string(),
  chat_id: z.string().min(1),
  chat_type: z.enum(["p2p", "group"]),
  message_type: z.string(),
  sender_id: z.string().min(1),
  /** "user" | "app" | ... — absent in older lark-cli event dumps. When
   *  present, non-"user" senders (bots) must never drive an agent run
   *  (H7: bot-to-bot loops). */
  sender_type: z.string().optional(),
  /** Topic/thread context (ADR 0037). lark-cli's own event schema declares
   *  all three ("Thread ID, when present" / "Root message ID of the
   *  reply/thread context, when present" / "Parent message ID of the direct
   *  reply context, when present") and used to be dropped here, which left the
   *  bot blind to whether a message belonged to an existing topic. */
  thread_id: z.string().optional(),
  root_id: z.string().optional(),
  reply_to: z.string().optional(),
  /** Structured mentions. Presence in THIS array is what proves a real @
   *  entity: lark-cli pre-renders `.content` to text (with mentions resolved
   *  to display names) and appends the compact array alongside it, so a typed
   *  "@name" appears in the text but never here.
   *
   *  `key` is the placeholder ("@_user_1"); `key === "@_all"` is an @everyone
   *  entry, which is NOT a mention of this bot.
   *
   *  There is deliberately no sender display name: lark-cli's own schema says
   *  "sender_id is open_id only — the event payload carries no display name",
   *  and the field this used to declare was never populated by anything. */
  mentions: z
    .array(
      z.object({
        /** Mentioned user's open_id. */
        id: z.string(),
        key: z.string(),
        name: z.string(),
      }),
    )
    .optional(),
  content: z.string(),
});

export type LarkMessageEvent = z.infer<typeof larkMessageEventSchema>;
