import type { FetchedComment } from "@larksuite/channel";

/**
 * ADR 0044: the comment notice carries ids, not text — the body has to be
 * fetched. This is the pure half of that: pick the triggering reply and turn
 * its elements into the text a run can read.
 *
 * The notice's `replyId` is the reply that @-mentioned the bot, and the fetch
 * returns the whole thread, so picking by id is what keeps a busy thread's
 * older replies from being answered instead of the new one. A reply the payload
 * does not name (a notice without `replyId`) falls back to the newest.
 */
export function commentBodyOf(fetched: FetchedComment, replyId?: string): string {
  const reply =
    (replyId ? fetched.replies.find((r) => r.reply_id === replyId) : undefined) ??
    fetched.replies[fetched.replies.length - 1];

  const body = (reply?.content?.elements ?? [])
    .map((element) => {
      if (element.type === "text_run") return element.text_run?.text ?? "";
      if (element.type === "docs_link") return element.docs_link?.url ?? "";
      // A `person` element is a mention. The notice already tells us who wrote
      // it, so the placeholder is enough — inventing a name would be worse.
      return "（提及某人）";
    })
    .join("")
    .trim();

  // An inline comment's selected text is what the comment is ABOUT; a
  // whole-document comment has none.
  const quote = fetched.quote?.trim();
  return quote ? `针对选中内容「${quote}」的评论：${body}` : body;
}
