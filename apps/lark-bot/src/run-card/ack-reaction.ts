import type { CardKitClient } from "./card-kit.js";

/**
 * The acknowledgement reaction's terminal half.
 *
 * Feishu has no typing indicator, so the bot puts a reaction on the user's
 * message while the run is live and swaps it for a "DONE" when the card
 * seals (openclaw does the first half for the same reason). Extracted from
 * the card watcher so the ordering is testable without an SSE stream: the
 * retraction must happen BEFORE the DONE is added, and a retraction that
 * fails must not stop the DONE.
 */

export interface AckReactionOutcome {
  /** Whether our acknowledgement was actually taken back. */
  removed: boolean;
  /** Whether the terminal reaction was left. */
  marked: boolean;
  /** First failure, for the row's lastError. Best-effort by design. */
  error?: string;
}

export async function swapAckReaction(
  cardClient: CardKitClient,
  input: { messageId: string; ackReactionId: string | null },
): Promise<AckReactionOutcome> {
  let error: string | undefined;
  let removed = false;

  if (input.ackReactionId) {
    const result = await cardClient.removeReaction(input.messageId, input.ackReactionId);
    removed = result.ok;
    if (!result.ok) error = `removeReaction: ${result.error}`;
  }

  const done = await cardClient.addReaction(input.messageId, "DONE");
  if (!done.ok && error === undefined) error = `doneReaction: ${done.error}`;

  return { removed, marked: done.ok, ...(error === undefined ? {} : { error }) };
}
