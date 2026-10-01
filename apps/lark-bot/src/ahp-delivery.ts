/** AHP chat state to Lark deliveries (ADR 0040: the surface contract is AHP).
 *
 *  Same books as the SSE path: one delivery row per message id, an intent state
 *  before the send and a terminal one after, plus the rule that a run card owning a
 *  run's delivery suppresses the text. The difference is that this reads *state*, so
 *  no seq cursor is needed - the table already answers what was delivered, which is
 *  what makes re-running the same state safe.
 *
 *  The identity comes from the part's `_meta.messageId`, which the projection
 *  carries out of the ledger. */
import type { Database } from "bun:sqlite";
import { isSucceededMessageState, MessageStateSchema } from "@chengchenccc/message";
import type { ChatState, ResponsePart } from "@microsoft/agent-host-protocol";
import {
  getMessageDelivery,
  rebindConversation,
  runCardOwnsDelivery,
  runIdFromMessageId,
  upsertMessageDelivery,
} from "./bindings-sqlite.js";
import { larkIdempotencyKey } from "./lark-idempotency.js";

export interface AhpDeliveryTarget {
  readonly conversationId: string;
  readonly larkChatId: string;
}

export interface AhpDeliveryDeps {
  readonly db: Database;
  readonly onSend: (chatId: string, text: string, idempotencyKey: string) => Promise<void>;
  readonly onRebind?: (oldConversationId: string, newConversationId: string) => void;
  readonly sendTextOnly?: (chatId: string, text: string) => Promise<void>;
  /** The state itself, for whatever else watches this conversation. The run card reads its own
   *  run out of it (ADR 0040 decision 4), so it is fed the same snapshot the delivery is. */
  readonly onChatState?: (state: ChatState, target: AhpDeliveryTarget) => void | Promise<void>;
}

/** Sends whatever the state says has not been sent yet. Safe to re-run. */
export async function deliverChatState(
  state: ChatState,
  target: AhpDeliveryTarget,
  deps: AhpDeliveryDeps,
): Promise<void> {
  for (const turn of state.turns) {
    await deliverParts(turn.responseParts, target, deps);
  }
  if (state.activeTurn) {
    await deliverParts(state.activeTurn.responseParts, target, deps);
  }
  await deps.onChatState?.(state, target);
}

async function deliverParts(
  parts: readonly ResponsePart[],
  target: AhpDeliveryTarget,
  deps: AhpDeliveryDeps,
): Promise<void> {
  for (const part of parts) {
    // Upstream's discriminant is a const enum: drop to a string before comparing.
    switch (part.kind as string) {
      case "markdown":
        await deliverText(part, target, deps);
        break;
      case "systemNotification":
        handleContinuity(part, target, deps);
        break;
      default:
        break;
    }
  }
}

async function deliverText(
  part: ResponsePart,
  target: AhpDeliveryTarget,
  deps: AhpDeliveryDeps,
): Promise<void> {
  const messageId = messageIdOf(part);
  const text = textOf(part);
  if (messageId === undefined || text === undefined || text === "") return;

  // ADR 0031 section 8: an assistant row encodes its run. When a run card owns this
  // chat's delivery, the card is the UX, so skip the text send (the card seals it).
  const runId = runIdFromMessageId(messageId);
  if (runId && runCardOwnsDelivery(deps.db, runId, target.larkChatId)) return;

  // Only a delivered message closes the row. `error` is terminal in the message state machine,
  // but for delivery it means "not sent": treating it as done would drop the reply silently.
  const existing = getMessageDelivery(deps.db, target.conversationId, messageId, target.larkChatId);
  if (existing && isSucceededMessageState(MessageStateSchema.parse(existing.lastState))) return;

  // Record intent before sending: a crash replays this, and the same idempotency
  // key makes that replay a no-op on Lark's side.
  record(deps, target, messageId, "streaming");
  try {
    await deps.onSend(
      target.larkChatId,
      text,
      larkIdempotencyKey(target.conversationId, messageId, target.larkChatId),
    );
    record(deps, target, messageId, "done");
  } catch (err) {
    // Record the failure and let it out: the watcher's loop reconnects on a throw, which re-reads
    // the snapshot and re-runs this delivery. Swallowing it would leave the reply unsent with
    // nothing left to trigger another attempt.
    record(deps, target, messageId, "error");
    console.error(`[ahp-delivery] send failed for ${messageId}:`, err);
    throw err;
  }
}

/** Continuity: rebind the conversation this table belongs to, and tell the user. */
function handleContinuity(
  part: ResponsePart,
  target: AhpDeliveryTarget,
  deps: AhpDeliveryDeps,
): void {
  const newConversationId = metaOf(part)?.newConversationId;
  if (typeof newConversationId !== "string") return;
  if (!rebindConversation(deps.db, target.conversationId, newConversationId)) return;
  console.log(
    `[ahp-delivery] rebind ${target.larkChatId}: ${target.conversationId} -> ${newConversationId}`,
  );
  deps.onRebind?.(target.conversationId, newConversationId);
  if (deps.sendTextOnly) void deps.sendTextOnly(target.larkChatId, "已开启新的对话。");
}

function record(
  deps: AhpDeliveryDeps,
  target: AhpDeliveryTarget,
  messageId: string,
  lastState: string,
): void {
  upsertMessageDelivery(deps.db, {
    conversationId: target.conversationId,
    messageId,
    larkChatId: target.larkChatId,
    lastState,
    lastSeq: 0,
    updatedAt: Date.now(),
  });
}

/** `_meta` is optional and not every part kind declares it; the `in` check narrows the union, so
 *  this reads the field without asserting a shape (bare casts are banned in this app). */
function metaOf(part: ResponsePart): Record<string, unknown> | undefined {
  if (!("_meta" in part)) return undefined;
  const meta = part._meta;
  return typeof meta === "object" && meta !== null ? meta : undefined;
}

function messageIdOf(part: ResponsePart): string | undefined {
  const messageId = metaOf(part)?.messageId;
  return typeof messageId === "string" ? messageId : undefined;
}

function textOf(part: ResponsePart): string | undefined {
  if (!("content" in part)) return undefined;
  return typeof part.content === "string" ? part.content : undefined;
}
