/** A one-shot timed nudge (raft step 2). Anchored to a conversation — at
 *  fire time the tick posts the text into it as a normal input and a regular
 *  run voices it. Only the author asked for it; delivery goes to the bound
 *  conversation (single user, single binding — per-message anchoring is
 *  deferred until multi-member rooms exist). */

export interface ReminderRow {
  id: string;
  conversationId: string;
  /** Agent id, or the constant "user". */
  createdBy: string;
  text: string;
  fireAt: number;
  /** Set on delivery. Null = pending (fires on the first tick past fireAt). */
  firedAt: number | null;
  createdAt: number;
}

export interface CreateReminderInput {
  conversationId: string;
  createdBy: string;
  text: string;
  fireAt: number;
}

/** The reminder service only needs to hand text to a conversation — the
 *  full postMessage surface stays behind this narrow seam. */
export type ReminderDeliver = (input: {
  conversationId: string;
  text: string;
}) => Promise<unknown>;

export class ReminderValidationError extends Error {}
