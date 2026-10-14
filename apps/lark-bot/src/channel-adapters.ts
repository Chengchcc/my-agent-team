import type {
  CardActionEvent as SdkCardActionEvent,
  CommentEvent,
  NormalizedMessage,
} from "@larksuite/channel";
import { type LarkMessageEvent, larkMessageEventSchema } from "@chengchenccc/api-contract";
import { z } from "zod";

/**
 * ADR 0044: the boundary between the official `@larksuite/channel` SDK and this
 * app's existing inbound pipeline.
 *
 * The pipeline was built against lark-cli's NDJSON: `parseEvent()` validates the
 * shared `LarkMessageEvent` contract (snake_case, in `@chengchenccc/api-contract`)
 * and `parseCardActionLine()` reads snake_case fields out of one JSON line. The
 * SDK hands over normalized objects instead. Rather than rewriting ingest /
 * merge-hold / the card pipeline, the two conversions below sit at the edge and
 * keep everything downstream byte-identical - which is the acceptance criterion:
 * a behavioural difference after the swap is a bug, not a feature.
 *
 * Both functions are pure and total: they never throw, and a payload the shared
 * schema rejects comes back as `null` (the same "drop it" answer `parseEvent`
 * gives for a malformed line).
 */

const PlainRecord = z.record(z.string(), z.unknown());

function recordOf(value: unknown): Record<string, unknown> | undefined {
  const parsed = PlainRecord.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `NormalizedMessage` → the shared `LarkMessageEvent` contract.
 *
 *  Field-by-field: the SDK normalizes identity and thread context onto typed
 *  fields (`threadId` / `rootId` / `replyToMessageId`, which the contract calls
 *  `thread_id` / `root_id` / `reply_to`), while the raw platform event carries
 *  the pieces the normal form drops (`message.create_time`, `sender_type`, and
 *  the mention display names our group gate matches on).
 *
 *  `event_id` is the one the raw body may not contain for messages (the card
 *  event's raw does). The message id is a safe identity fallback: it is unique,
 *  and `inbound_message` already dedups on it. */
export function toLarkMessageEvent(msg: NormalizedMessage): LarkMessageEvent | null {
  const raw = recordOf(msg.raw) ?? {};
  const rawMessage = recordOf(raw.message) ?? {};
  const rawHeader = recordOf(raw.header) ?? {};
  const eventId = str(raw.event_id) ?? str(rawHeader.event_id) ?? msg.messageId;

  const mentions = (msg.mentions ?? [])
    .map((m) => ({ id: m.openId ?? m.userId ?? "", key: m.key, name: m.name ?? "" }))
    .filter((m) => m.key.length > 0);

  const candidate = {
    type: "im.message.receive_v1",
    event_id: eventId,
    timestamp: str(rawMessage.create_time) ?? String(msg.createTime ?? 0),
    id: eventId,
    message_id: msg.messageId,
    create_time: str(rawMessage.create_time) ?? String(msg.createTime ?? 0),
    chat_id: msg.chatId,
    // The SDK's chatType is already 'p2p' | 'group'.
    chat_type: msg.chatType,
    message_type: str(msg.rawContentType) ?? str(rawMessage.message_type) ?? "text",
    sender_id: msg.senderId,
    // H7: non-"user" senders must never drive a run. `senderType` is passed
    // through from the raw event; `senderIsBot` is the SDK's derived convenience.
    ...(str(msg.senderType) ? { sender_type: msg.senderType } : {}),
    ...(str(msg.threadId) ? { thread_id: msg.threadId } : {}),
    ...(str(msg.rootId) ? { root_id: msg.rootId } : {}),
    ...(str(msg.replyToMessageId) ? { reply_to: msg.replyToMessageId } : {}),
    ...(mentions.length > 0 ? { mentions } : {}),
    content: msg.content,
  };

  const parsed = larkMessageEventSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** One flat string map, matching how `parseCardActionLine` already flattens
 *  `form_value` (string / number / boolean / string-array). */
function flattenFormValue(form: Record<string, unknown>): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(form)) {
    if (typeof v === "string") flat[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") flat[k] = String(v);
    else if (Array.isArray(v)) {
      flat[k] = v.filter((x): x is string => typeof x === "string").join(",");
    }
  }
  return flat;
}

/** `CardActionEvent` (SDK) → the NDJSON line `parseCardActionLine` consumes.
 *
 *  Reusing that line as the interchange keeps every downstream guarantee this
 *  app already has for card actions: the field search, the unknown-message
 *  rejection against the local `run_card` row, and `reserveEventId` dedup.
 *
 *  Two things differ from the lark-cli line and are handled here:
 *   - `action.value` arrives as a parsed object (our decoder takes a JSON
 *     string), so it is stringified back;
 *   - the dedup key is `raw.event_id`, with a deterministic fallback built from
 *     the message, the action and the operator. */
export function toCardActionLine(evt: SdkCardActionEvent): string {
  const raw = recordOf(evt.raw) ?? {};
  const eventId =
    str(raw.event_id) ??
    `${evt.messageId}:${evt.action?.tag ?? ""}:${evt.operator?.openId ?? ""}:${evt.action?.name ?? ""}`;

  const value = evt.action?.value;
  const form = recordOf(evt.action?.formValue);
  const flatForm = form ? flattenFormValue(form) : {};

  return JSON.stringify({
    event_id: eventId,
    operator_id: evt.operator?.openId ?? "",
    chat_id: evt.chatId,
    message_id: evt.messageId,
    action_tag: evt.action?.tag ?? "",
    action_value: typeof value === "string" ? value : JSON.stringify(value ?? {}),
    ...(str(evt.action?.name) ? { action_name: evt.action.name } : {}),
    ...(Object.keys(flatForm).length > 0 ? { form_value: flatForm } : {}),
  });
}

/** The fields a comment-triggered run needs from the SDK's `CommentEvent`.
 *
 *  `fileToken` + `commentId` identify the comment THREAD, which ADR 0044 makes
 *  the conversation scope (one comment line = one conversation, mirroring
 *  topics); `replyId` is where the notice was raised, and `mentionedBot` is the
 *  trigger gate. Nothing here needs the SDK's own target resolution - the
 *  subscribe call and `comments.reply` take the file token and type as-is. */
export interface CommentTrigger {
  fileToken: string;
  fileType: string;
  commentId: string;
  replyId?: string;
  operatorOpenId: string;
  mentionedBot: boolean;
  /** Event identity for dedup, from the raw body when present. */
  eventId: string;
}

export function toCommentTrigger(evt: CommentEvent): CommentTrigger | null {
  const raw = recordOf(evt.raw) ?? {};
  const fileToken = str(evt.fileToken);
  const commentId = str(evt.commentId);
  if (!fileToken || !commentId) return null;
  return {
    fileToken,
    fileType: str(evt.fileType) ?? "docx",
    commentId,
    ...(str(evt.replyId) ? { replyId: evt.replyId } : {}),
    operatorOpenId: evt.operator?.openId ?? "",
    mentionedBot: evt.mentionedBot === true,
    eventId: str(raw.event_id) ?? `${fileToken}:${commentId}`,
  };
}
