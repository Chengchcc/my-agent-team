/**
 * ADR 0044: a comment line (a document + one comment thread) is a conversation,
 * exactly as a topic is (ADR 0037).
 *
 * Every chat-shaped mechanism in this app is keyed by a Lark chat id: the
 * delivery cursor in `conversation_binding`, the `message_delivery` ledger,
 * `larkIdempotencyKey`, the AHP watcher's target. Rather than teach all of them
 * about a second kind of scope, a comment conversation carries a SYNTHETIC chat
 * id and only the send step reads it back — one seam instead of six.
 *
 * The format is flat and colon-delimited because Feishu tokens and comment ids
 * are alphanumeric, so the split is unambiguous.
 */

const PREFIX = "comment:";

/** The synthetic chat id of one comment thread. */
export function commentChatId(fileToken: string, commentId: string): string {
  return `${PREFIX}${fileToken}:${commentId}`;
}

export function isCommentChatId(chatId: string): boolean {
  return chatId.startsWith(PREFIX);
}

/** What a synthetic chat id points at; null when it is an ordinary chat id
 *  (or a malformed one, which must not be answered anywhere). */
export function parseCommentChatId(
  chatId: string,
): { fileToken: string; commentId: string } | null {
  if (!isCommentChatId(chatId)) return null;
  const rest = chatId.slice(PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { fileToken: rest.slice(0, sep), commentId: rest.slice(sep + 1) };
}
