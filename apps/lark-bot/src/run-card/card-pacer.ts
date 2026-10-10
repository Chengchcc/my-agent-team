import type { CardKitClient } from "./card-kit.js";

/** One write lane per chat (#87).
 *
 *  Feishu's card rate limit (230020, "ext=chat rate limit") is per CHAT, not
 *  per card. A burst of runs puts several cards in one chat, and each streams
 *  element updates on its own ticker — separate cards, shared budget, so the
 *  chat trips the limit and every card in it starts failing. Waiting it out
 *  (the seal's congestion budget) is not enough: measured live, the congestion
 *  outlasted 45 seconds of retries, because we were the ones keeping the chat
 *  saturated.
 *
 *  So writes to the same chat take turns, with a minimum spacing between
 *  starts. Serialization alone would not cap the rate (one card's own flush
 *  bursts), and spacing alone would not order concurrent cards — both halves
 *  are needed. Reads are not paced: they are rare and do not count against the
 *  write budget. */
export interface PaceClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: PaceClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

interface Lane {
  tail: Promise<void>;
  lastStart: number;
}

const lanes = new Map<string, Lane>();

/** Minimum spacing between write starts on one chat. Calibration knob: a test
 *  drives the lane without real delays. */
export const CARD_WRITE_MIN_SPACING_MS = 250;

export function paceCardWrite<T>(
  chatId: string,
  op: () => Promise<T>,
  clock: PaceClock = realClock,
): Promise<T> {
  const lane = lanes.get(chatId) ?? { tail: Promise.resolve(), lastStart: 0 };
  const run = lane.tail.then(async () => {
    const wait = lane.lastStart + CARD_WRITE_MIN_SPACING_MS - clock.now();
    if (wait > 0) await clock.sleep(wait);
    lane.lastStart = clock.now();
    return op();
  });
  lane.tail = run.then(
    () => {},
    () => {},
  );
  lanes.set(chatId, lane);
  return run;
}

/** Test seam: forget the lanes (a stale lane would serialize a later test's
 *  calls against a finished one). */
export function resetCardPacerLanes(): void {
  lanes.clear();
}

/** Test seam: a lane with no spacing and no waiting, so existing card tests do
 *  not pay the real 250ms between writes. */
export const instantCardPaceClock: PaceClock = {
  now: () => Number.MAX_SAFE_INTEGER,
  sleep: async () => {},
};

/** Wrap a CardKit client so every WRITE goes through its chat's lane. Reads
 *  (getChatMode) stay direct. Both card paths use this — the run card and the
 *  queued card — because they share the chat, and therefore the budget. */
export function pacedCardClient<T extends CardKitClient>(
  client: T,
  chatId: string,
  clock?: PaceClock,
): T {
  const pace = <R>(op: () => Promise<R>): Promise<R> => paceCardWrite(chatId, op, clock);
  return {
    ...client,
    createCard: (card) => pace(() => client.createCard(card)),
    sendCard: (chat, cardId, opts) => pace(() => client.sendCard(chat, cardId, opts)),
    streamElement: (input) => pace(() => client.streamElement(input)),
    updateCard: (cardId, card, sequence) => pace(() => client.updateCard(cardId, card, sequence)),
    closeStreaming: (cardId, sequence) => pace(() => client.closeStreaming(cardId, sequence)),
    addReaction: (messageId, emojiType) => pace(() => client.addReaction(messageId, emojiType)),
    removeReaction: (messageId, reactionId) =>
      pace(() => client.removeReaction(messageId, reactionId)),
  };
}
