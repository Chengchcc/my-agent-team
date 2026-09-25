import type { Database } from "bun:sqlite";
import { getActiveRunCardByLarkMessage } from "../bindings-sqlite.js";

/** Reactions that mean "stop this run". The keys are Feishu's emoji keys, not
 *  the glyphs: X is ❌ and THUMBSDOWN is 👎, the two a person reaches for when
 *  they want something to stop. Any other reaction is ignored - people react
 *  to acknowledge, and an ✋/👍 that killed a run would be a trap.
 *
 *  The exact key a client sends for ❌ is learned from the probe line below on
 *  the first real reaction: if it lands as something else, the log says so. */
export const STOP_REACTIONS = new Set(["X", "THUMBSDOWN"]);

export interface ReactionEvent {
  eventId?: string;
  messageId?: string;
  chatId?: string;
  operatorId?: string;
  reactionKey?: string;
}

/** lark-cli prints one line per event; the shape is flat (key/value) and has
 *  not been observed from a real reaction yet, so this reads the plausible
 *  spellings and hands anything it cannot place to the caller as undefined -
 *  a wrong guess must not silently stop a run. */
export function parseReactionLine(line: string): ReactionEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const found: ReactionEvent = {};
  const read = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      if (!Object.hasOwn(parsed, key)) continue;
      const value: unknown = Reflect.get(parsed, key);
      if (typeof value === "string") return value;
    }
    return undefined;
  };
  found.eventId = read("event_id", "eventId");
  found.messageId = read("message_id", "messageId");
  found.chatId = read("chat_id", "chatId");
  found.operatorId = read("operator_id", "operatorId", "user_id");
  found.reactionKey = read("reaction_type", "reactionType", "emoji_type");
  if (!found.messageId && !found.reactionKey) return null;
  return found;
}

export type ReactionOutcome = "stopped" | "ignored-reaction" | "no-live-card" | "unparsed";

/** A reaction on a message that carries a live Run card stops that run. The
 *  card is the lookup key (its own row maps message -> run), so a reaction on
 *  any other message - including the bot's plain text - is inert. */
export async function handleReactionLine(
  line: string,
  deps: {
    db: Database;
    cancelRun: (runId: string) => Promise<{ error?: unknown }>;
    /** Observability: the first real reaction teaches the wire shape. */
    log: (message: string) => void;
  },
): Promise<ReactionOutcome> {
  const event = parseReactionLine(line);
  if (!event?.messageId) {
    deps.log(`reaction unparsed: ${line.slice(0, 200)}`);
    return "unparsed";
  }
  const card = getActiveRunCardByLarkMessage(deps.db, event.messageId);
  if (!card) return "no-live-card";
  deps.log(
    `reaction on run card runId=${card.runId} key=${event.reactionKey ?? "(none)"} ` +
      `operator=${event.operatorId ?? "(none)"} event=${event.eventId ?? "(none)"}`,
  );
  if (!event.reactionKey || !STOP_REACTIONS.has(event.reactionKey)) return "ignored-reaction";
  const { error } = await deps.cancelRun(card.runId);
  if (error) {
    deps.log(`reaction stop failed runId=${card.runId}: ${String(error)}`);
    return "ignored-reaction";
  }
  deps.log(`reaction stopped runId=${card.runId}`);
  return "stopped";
}
