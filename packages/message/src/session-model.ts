/** 会话的规范模型（ADR 0040 决策三）。
 *
 *  它回答「一个会话是什么」，与谁来渲染无关：一次执行就是一个 turn，里面是
 *  类型化的 part；工具调用是一等对象，use 与 result 按 `tool_use_id` 配对；
 *  人工输入请求挂在所属的 turn 上。ACP 与 AHP 两端都按字段级绑定到这个形状，
 *  这正是目的：任何一端都不必再重建轮次，或从消息载荷里翻找工具事实。
 *
 *  本模块是纯的、不碰数据库（协议层）。哪几行账本构成哪个 turn，由后端的
 *  session-model 派生器负责。 */
import type { ContentBlock } from "./content-block.js";
import type { Message, MessageUsage } from "./message.js";

export type CanonicalToolCallStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface CanonicalToolResult {
  readonly content: string;
  readonly isError: boolean;
}

/** 一次工具调用。`toolCallId` 是模型给出的调用 id（ACP 与 AHP 同名同义）。 */
export interface CanonicalToolCall {
  readonly toolCallId: string;
  readonly name: string;
  readonly input: unknown;
  readonly status: CanonicalToolCallStatus;
  readonly result?: CanonicalToolResult;
}

/** 挂在轮次上的人工输入（审批、问答）。`status` 与 `response` 来自产品的
 *  durable 记录，所以「当时问了什么、答了什么」在模型里就是一段状态。 */
export interface CanonicalInputRequest {
  readonly requestId: string;
  readonly kind: string;
  readonly status: "pending" | "resolved" | "cancelled";
  /** 审批针对的那次工具调用（有则挂上，方便两端按调用渲染卡片）。 */
  readonly toolCallId?: string;
  readonly response?: unknown;
}

export type CanonicalPart =
  | { readonly kind: "text"; readonly text: string; readonly messageId?: string }
  | { readonly kind: "thinking"; readonly text: string; readonly messageId?: string }
  | { readonly kind: "toolCall"; readonly toolCall: CanonicalToolCall; readonly messageId?: string }
  | {
      readonly kind: "inputRequest";
      readonly request: CanonicalInputRequest;
      readonly messageId?: string;
    }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly code?: string;
      readonly messageId?: string;
    };

export type CanonicalTurnStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";

export interface CanonicalTurn {
  /** 我们这边 turn 就是一次 Run，所以 turnId 即 runId（ADR 0040 决策三）。 */
  readonly turnId: string;
  /** 触发这次执行的用户消息（AHP 的 `ActiveTurn.message` 位置）。 */
  readonly input?: Message;
  readonly status: CanonicalTurnStatus;
  readonly parts: readonly CanonicalPart[];
  readonly usage?: MessageUsage;
}

/** 一轮的 part，按到达到顺序。工具调用按 `tool_use_id` 配对：结果会落到对应的
 *  call 上并把它标成 completed 或 failed。**配不上 use 的 result 也会保留**，
 *  落成一次已结算的调用；丢掉它就是又把事实漏出日志。 */
/** 给片段挂上来源消息的身份（账本身份，surface 靠它做恰好一次投递）。
 *  没有身份时连键都不出现：`undefined` 与「没有这个字段」不是一个意思。 */
function withMessageId<T extends object>(
  part: T,
  messageId: string | undefined,
): T & { messageId?: string } {
  return messageId === undefined ? part : { ...part, messageId };
}

export function turnPartsFromMessages(messages: readonly Message[]): CanonicalPart[] {
  const parts: CanonicalPart[] = [];
  const callIndex = new Map<string, number>();

  for (const message of messages) {
    if (message.text !== undefined && message.text !== "") {
      parts.push(withMessageId({ kind: "text", text: message.text }, message.id));
    }
    for (const block of message.blocks ?? []) {
      pushBlock(parts, callIndex, block, message.id);
    }
    if (message.error) {
      parts.push(
        withMessageId(
          {
            kind: "error",
            message: message.error.message,
            ...(message.error.code !== undefined ? { code: message.error.code } : {}),
          },
          message.id,
        ),
      );
    }
  }
  return parts;
}

function pushBlock(
  parts: CanonicalPart[],
  callIndex: Map<string, number>,
  block: ContentBlock,
  messageId: string | undefined,
): void {
  if (block.type === "text") {
    parts.push(withMessageId({ kind: "text", text: block.text }, messageId));
    return;
  }
  if (block.type === "thinking") {
    parts.push(withMessageId({ kind: "thinking", text: block.text }, messageId));
    return;
  }
  if (block.type === "tool_use") {
    callIndex.set(block.id, parts.length);
    parts.push(
      withMessageId(
        {
          kind: "toolCall",
          toolCall: {
            toolCallId: block.id,
            name: block.name,
            input: block.input,
            status: "pending",
          },
        },
        messageId,
      ),
    );
    return;
  }
  if (block.type === "tool_result") {
    const result: CanonicalToolResult = {
      content: block.content,
      isError: block.is_error ?? false,
    };
    const index = callIndex.get(block.tool_use_id);
    const part = index === undefined ? undefined : parts[index];
    if (part?.kind === "toolCall") {
      parts[index!] = withMessageId(
        {
          kind: "toolCall",
          toolCall: {
            ...part.toolCall,
            status: result.isError ? "failed" : "completed",
            result,
          },
        },
        messageId,
      );
      return;
    }
    parts.push(
      withMessageId(
        {
          kind: "toolCall",
          toolCall: {
            toolCallId: block.tool_use_id,
            name: "unknown",
            input: {},
            status: result.isError ? "failed" : "completed",
            result,
          },
        },
        messageId,
      ),
    );
  }
  // 图片等块不单独成 part。
}

/** 把人工输入请求插进 part 序列：有 `toolCallId` 的挂在对应调用之后，没有的
 *  追加在末尾。顺序稳定，便于两端渲染同一张卡。 */
export function attachInputRequests(
  parts: readonly CanonicalPart[],
  requests: readonly CanonicalInputRequest[],
): CanonicalPart[] {
  if (requests.length === 0) return [...parts];
  const out = [...parts];
  const trailing: CanonicalInputRequest[] = [];
  for (const request of requests) {
    const index = out.findIndex(
      (part) => part.kind === "toolCall" && part.toolCall.toolCallId === request.toolCallId,
    );
    if (index === -1) {
      trailing.push(request);
      continue;
    }
    out.splice(index + 1, 0, { kind: "inputRequest", request });
  }
  return [...out, ...trailing.map((request) => ({ kind: "inputRequest", request }) as const)];
}
