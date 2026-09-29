/** AHP 状态 → Lark 投递（ADR 0040：surface 契约归 AHP）。
 *
 *  与旧的 SSE 路径共用同一套账：按 messageId 的一次投递表（先记意图、成功后记终态），
 *  以及「Run 卡已接管就不再发文本」那条缝。区别在于这里吃的是**状态**，所以不需要
 *  seq 游标 —— 「哪些已投递」由投递表自己回答，重复跑同一份状态是安全的。
 *
 *  投递身份取自片段的 `_meta.messageId`（后端把账本的消息 id 透出来）。 */
import type { Database } from "bun:sqlite";
import { isTerminalMessageState, MessageStateSchema } from "@chengchenccc/message";
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
}

/** 把一份 chat 状态里该发的内容发出去。可重复调用：已投递的会自己跳过。 */
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
}

async function deliverParts(
  parts: readonly ResponsePart[],
  target: AhpDeliveryTarget,
  deps: AhpDeliveryDeps,
): Promise<void> {
  for (const part of parts) {
    // 上游的判别式是 const enum：比字面量前先落到字符串。
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

  // ADR 0031 §8：assistant 行编码了它的 Run。若 Run 卡接管了这个 chat 的投递，
  // 卡片就是 UX，跳过文本发送（卡片自己会在终态收尾）。
  const runId = runIdFromMessageId(messageId);
  if (runId && runCardOwnsDelivery(deps.db, runId, target.larkChatId)) return;

  const existing = getMessageDelivery(deps.db, target.conversationId, messageId, target.larkChatId);
  if (existing && isTerminalMessageState(MessageStateSchema.parse(existing.lastState))) return;

  // 先记意图再发：崩在中间会重放，同一把幂等键让 Lark 侧去重。
  record(deps, target, messageId, "streaming");
  try {
    await deps.onSend(
      target.larkChatId,
      text,
      larkIdempotencyKey(target.conversationId, messageId, target.larkChatId),
    );
    record(deps, target, messageId, "done");
  } catch (err) {
    record(deps, target, messageId, "error");
    console.error(`[ahp-delivery] send failed for ${messageId}:`, err);
  }
}

/** 续接：改绑投递表所在的那条会话，并告诉用户这里开了新对话。 */
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

function metaOf(part: ResponsePart): Record<string, unknown> | undefined {
  const meta = (part as { _meta?: unknown })._meta;
  return meta !== null && typeof meta === "object" ? (meta as Record<string, unknown>) : undefined;
}

function messageIdOf(part: ResponsePart): string | undefined {
  const messageId = metaOf(part)?.messageId;
  return typeof messageId === "string" ? messageId : undefined;
}

function textOf(part: ResponsePart): string | undefined {
  const content = (part as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}
