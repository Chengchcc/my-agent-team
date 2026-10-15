import type { CommentTarget } from "@larksuite/channel";

/**
 * The acknowledgement reaction, comment edition (ADR 0044).
 *
 * Feishu has no typing indicator, so the chat lane puts an "OnIt" reaction on
 * the user's message while a run is live and swaps it for a "DONE" when the run
 * seals (`run-card/ack-reaction.ts`). The comment lane has no card to paint, so
 * the reaction is the ONLY signal between "the bot saw this" and the answer
 * arriving — without it a comment sits in silence for the length of a run.
 *
 * Same ordering rule as the chat side: the acknowledgement is taken back BEFORE
 * the terminal mark goes on, and neither step may cost the other.
 */

/** The reaction while the run is live. The SDK's own default for comment
 *  replies, and the same emoji the reference implementation uses. */
const PROCESSING = "Typing";
/** The terminal mark, matching the chat lane's. */
const DONE = "DONE";

/** The slice of the comment surface this needs. Structural on purpose: the SDK
 *  class carries far more, and a test double should not have to fake it. The
 *  return type is `unknown` because the SDK answers a boolean here while a fake
 *  may answer void — neither is read. */
export interface CommentReactionSurface {
  addReaction(target: CommentTarget, replyId: string, emojiType?: string): Promise<unknown>;
  removeReaction(target: CommentTarget, replyId: string, emojiType?: string): Promise<unknown>;
}

/** Marks the triggering reply as seen. Never throws: a refused reaction is
 *  cosmetic, and losing the run over it would be absurd. */
export async function ackCommentProcessing(
  surface: CommentReactionSurface,
  target: CommentTarget,
  replyId: string,
): Promise<boolean> {
  try {
    await surface.addReaction(target, replyId, PROCESSING);
    return true;
  } catch (err) {
    console.error(
      `[lark-bot] comment ack failed for ${replyId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/** Swaps the acknowledgement for the terminal mark. Runs after a reply lands,
 *  and is therefore idempotent in practice: the second call's retraction finds
 *  nothing to take back and its mark is already there. Both failures are logged
 *  and swallowed — the answer itself has already been delivered. */
export async function markCommentDone(
  surface: CommentReactionSurface,
  target: CommentTarget,
  replyId: string,
): Promise<void> {
  try {
    await surface.removeReaction(target, replyId, PROCESSING);
  } catch {
    /* already gone, or never placed: the mark below is what matters */
  }
  try {
    await surface.addReaction(target, replyId, DONE);
  } catch (err) {
    console.error(
      `[lark-bot] comment done-mark failed for ${replyId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
