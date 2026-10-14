import type { Database } from "bun:sqlite";
import {
  confirmInbound,
  findConversationByComment,
  getMemberBinding,
  inboundExists,
  putCommentBinding,
  putConversationBinding,
  putMemberBinding,
  reserveInbound,
} from "./bindings-sqlite.js";
import type { CommentTrigger } from "./channel-adapters.js";
import { commentChatId } from "./comment-scope.js";

/**
 * ADR 0044: a comment line is a conversation, so its inbound has the same
 * reserve → create → bind → post → confirm shape as `ingest()` — and the same
 * trade-off ("lose an inbound rather than duplicate a run trigger").
 *
 * What is deliberately absent: the policy gate and mention routing (the comment
 * handler decides what may trigger), topics, images and merge-holding. A comment
 * line has none of those shapes, and sharing `ingest()` would have meant
 * teaching every one of them about a second world.
 *
 * Dedup identity is the NOTICE, not the comment: every reply in a thread is its
 * own notice with its own event id, and the thread's later replies must keep
 * triggering turns — keying on (fileToken, commentId) would swallow them.
 * The conversation, by contrast, IS keyed by the thread, which is what makes
 * every notice in one thread continue one conversation.
 */

export interface CommentIngestDeps {
  db: Database;
  /** Creates a conversation in the backend (the same call `ingest` makes).
   *  Null means the backend refused; the inbound stays reserved. */
  createConversation: () => Promise<string | null>;
  /** Posts one human message; an error string means the conversation exists but
   *  the turn did not start. */
  postMessage: (input: {
    conversationId: string;
    senderMemberId: string;
    text: string;
  }) => Promise<{ error?: string }>;
  /** Fired when a NEW comment line is bound, so its AHP watcher can start. */
  onNewBinding?: (conversationId: string, chatId: string) => void;
}

export interface CommentIngestResult {
  action: "triggered" | "skipped" | "error";
  conversationId?: string;
}

export async function ingestComment(
  trigger: CommentTrigger,
  text: string,
  deps: CommentIngestDeps,
): Promise<CommentIngestResult> {
  const { db } = deps;
  const chatId = commentChatId(trigger.fileToken, trigger.commentId);
  const noticeId = trigger.replyId ?? trigger.eventId;

  const reserved = db.transaction(() => {
    if (inboundExists(db, trigger.eventId, noticeId)) return null;
    reserveInbound(db, trigger.eventId, noticeId, chatId);

    let memberId = getMemberBinding(db, chatId, trigger.operatorOpenId);
    if (!memberId) {
      memberId = `human:lark:${trigger.operatorOpenId}`;
      putMemberBinding(db, chatId, trigger.operatorOpenId, memberId);
    }
    return {
      memberId,
      conversationId: findConversationByComment(db, trigger.fileToken, trigger.commentId),
    };
  })();
  if (!reserved) return { action: "skipped" };

  let conversationId = reserved.conversationId;
  if (!conversationId) {
    const created = await deps.createConversation();
    if (!created) return { action: "error" };

    // Rows are built here, not inside the closure: the transaction keeps them
    // atomic, while a captured `string | null` would need a non-null assertion.
    const now = Date.now();
    const commentRow = {
      conversationId: created,
      fileToken: trigger.fileToken,
      fileType: trigger.fileType,
      commentId: trigger.commentId,
      createdAt: now,
    };
    // The synthetic chat id is the whole trick: the delivery cursor, the
    // message ledger and the AHP watcher are chat-shaped and take it as-is.
    const conversationRow = {
      conversationId: created,
      larkChatId: chatId,
      chatType: "p2p",
      chatMode: null,
      topicRootMessageId: null,
      createdAt: now,
    };
    db.transaction(() => {
      putCommentBinding(db, commentRow);
      putConversationBinding(db, conversationRow);
    })();

    conversationId = created;
    deps.onNewBinding?.(created, chatId);
  }

  const posted = await deps.postMessage({
    conversationId,
    senderMemberId: reserved.memberId,
    text,
  });
  if (posted.error) {
    console.error(`[ingest-comment] post failed: ${posted.error}`);
    return { action: "error", conversationId };
  }

  confirmInbound(db, trigger.eventId, conversationId, null);
  return { action: "triggered", conversationId };
}
