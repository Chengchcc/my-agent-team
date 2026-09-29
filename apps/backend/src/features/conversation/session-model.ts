/** 从账本与执行账目派生规范模型（ADR 0040 决策三）。
 *
 *  输入是**普通行对象**，不碰数据库：账本行、输入队列行、Run 行、待处理动作行。
 *  输出是可被两种协议按字段级绑定的轮次（`CanonicalTurn`）。
 *
 *  派生只用已存在的链接，不做推断：
 *  - 轮次 = 一次 Run；触发它的用户消息来自输入队列（`run_id` 链接）；
 *  - 片段 = 该 Run 的账本行，按 `message_index` 升序；
 *  - 工具调用 = `tool_use` 与 `tool_result` 按 `tool_use_id` 配对（见 packages/message）；
 *  - 人工输入 = 待处理动作按 `run_id` 挂到轮次，带 `callId` 的再挂到具体调用上。 */
import {
  attachInputRequests,
  type CanonicalInputRequest,
  type CanonicalPart,
  type CanonicalTurn,
  type CanonicalTurnStatus,
  deserializeLedgerContent,
  type Message,
  turnPartsFromMessages,
} from "@chengchenccc/message";

export interface SessionModelLedgerRow {
  readonly seq: number;
  readonly conversationId: string;
  /** 存储行原样：读库路径给的是已解析对象，实时推送路径给的是字符串，这里都收。 */
  readonly content: unknown;
  readonly agentRunId: string | null;
  readonly messageIndex: number;
}

export interface SessionModelQueueRow {
  readonly inputId: string;
  readonly runId: string | null;
  readonly mode: string;
  /** 序列化的 Message（JSON）。 */
  readonly message: string;
}

export interface SessionModelRunRow {
  readonly runId: string;
  readonly status: string;
  readonly createdAt?: number;
}

export interface SessionModelPendingActionRow {
  readonly actionId: string;
  readonly runId: string;
  readonly kind: string;
  readonly status: string;
  readonly payload: string;
  readonly response?: string | null;
}

export interface BuildTurnsInput {
  /** 顺序不限；内部按 (run, message_index) 归组排序。 */
  readonly ledger: readonly SessionModelLedgerRow[];
  readonly queue: readonly SessionModelQueueRow[];
  readonly runs: readonly SessionModelRunRow[];
  readonly pendingActions: readonly SessionModelPendingActionRow[];
}

export function buildTurns(input: BuildTurnsInput): CanonicalTurn[] {
  const messagesByRun = groupLedgerMessages(input.ledger);
  const inputByRun = mapQueueInputs(input.queue);
  const requestsByRun = mapPendingActions(input.pendingActions);
  const errorByRun = errorPartsByRun(input.ledger);

  return input.runs.map((run) => {
    const requests = requestsByRun.get(run.runId) ?? [];
    const attached = attachInputRequests(
      turnPartsFromMessages(messagesByRun.get(run.runId) ?? []),
      requests,
    );
    const errorPart = errorByRun.get(run.runId);
    const parts = errorPart ? [...attached, errorPart] : attached;
    const message = inputByRun.get(run.runId);
    return {
      turnId: run.runId,
      ...(message ? { input: message } : {}),
      status: turnStatus(run.status),
      parts,
    };
  });
}

/** 失败轮次的错误片段。T3-2 的持久化气泡（`run:<runId>:error`）不挂 `agent_run_id`，
 *  按 run 归组会被跳过，失败事实就进不了规范模型。它用 messageId 指认自己属于哪个 Run，
 *  折成那一轮的末尾；账本行本身保留，等 surface 切到规范模型后再撤掉写入方。 */
function errorPartsByRun(ledger: readonly SessionModelLedgerRow[]): Map<string, CanonicalPart> {
  const out = new Map<string, CanonicalPart>();
  for (const row of ledger) {
    if (row.agentRunId !== null) continue;
    let revision: {
      messageId?: unknown;
      error?: { message?: unknown; code?: unknown };
      text?: unknown;
    };
    try {
      revision = deserializeLedgerContent(asJsonString(row.content)) as typeof revision;
    } catch {
      continue;
    }
    const messageId = revision.messageId;
    if (typeof messageId !== "string") continue;
    const match = /^run:(.+):error$/.exec(messageId);
    if (!match) continue;
    const error = revision.error ?? {};
    const message =
      typeof error.message === "string"
        ? error.message
        : typeof revision.text === "string"
          ? revision.text
          : "run failed";
    out.set(match[1]!, {
      kind: "error",
      message,
      ...(typeof error.code === "string" ? { code: error.code } : {}),
    });
  }
  return out;
}

/** 两种来源的形状归一：读库路径是对象，实时推送路径是字符串。 */
function asJsonString(content: unknown): string {
  return typeof content === "string" ? content : (JSON.stringify(content) ?? "null");
}

/** 一轮里所有能指认 Run 的地方：账本归属、队列输入、失败气泡指名的 Run。
 *  失败气泡的 id 形状只在这里出现一次 —— 它由产品写入，面不该认这个约定。 */
export function canonicalRunIds(input: {
  readonly ledger: readonly { readonly agentRunId?: string | null; readonly content?: unknown }[];
  readonly queue: readonly { readonly runId?: string | null }[];
}): string[] {
  const ids = new Set<string>();
  for (const row of input.ledger) {
    if (row.agentRunId) ids.add(row.agentRunId);
    else {
      const bubble = bubbleRunId(row.content);
      if (bubble) ids.add(bubble);
    }
  }
  for (const row of input.queue) if (row.runId) ids.add(row.runId);
  return [...ids];
}

/** T3-2 的持久化气泡：`run:<runId>:error` 的 messageId 指向它属于哪个 Run。 */
function bubbleRunId(content: unknown): string | undefined {
  try {
    const parsed = (typeof content === "string" ? JSON.parse(content) : content) as {
      messageId?: unknown;
    };
    const id = parsed?.messageId;
    return typeof id === "string" ? /^run:(.+):error$/.exec(id)?.[1] : undefined;
  } catch {
    return undefined;
  }
}

function groupLedgerMessages(ledger: readonly SessionModelLedgerRow[]): Map<string, Message[]> {
  const byRun = new Map<string, SessionModelLedgerRow[]>();
  for (const row of ledger) {
    if (row.agentRunId === null) continue;
    const rows = byRun.get(row.agentRunId);
    if (rows) rows.push(row);
    else byRun.set(row.agentRunId, [row]);
  }
  const out = new Map<string, Message[]>();
  for (const [runId, rows] of byRun) {
    // 只认 message_index 顺序：账本 seq 是对话级共享顺序，run 内顺序由它表达。
    const ordered = [...rows].sort((a, b) => a.messageIndex - b.messageIndex);
    const messages: Message[] = [];
    for (const row of ordered) {
      const parsed = deserializeLedgerContent(asJsonString(row.content));
      if ("messageId" in parsed) messages.push(revisionToMessage(parsed));
    }
    out.set(runId, messages);
  }
  return out;
}

/** MessageRevision（账本行）到 Message 的直译：字段同名，只换 id 字段名。 */
function revisionToMessage(revision: ReturnType<typeof deserializeLedgerContent>): Message {
  if (!("messageId" in revision)) return { role: "system", text: "" };
  return {
    id: revision.messageId,
    role: revision.role,
    ...(revision.state !== undefined ? { state: revision.state } : {}),
    ...(revision.text !== undefined ? { text: revision.text } : {}),
    ...(revision.blocks !== undefined ? { blocks: revision.blocks } : {}),
    ...(revision.tools !== undefined ? { tools: revision.tools } : {}),
    ...(revision.conversationId !== undefined ? { conversationId: revision.conversationId } : {}),
    ...(revision.visibility !== undefined ? { visibility: revision.visibility } : {}),
    ...(revision.error !== undefined ? { error: revision.error } : {}),
    updatedAt: revision.updatedAt,
  };
}

function mapQueueInputs(queue: readonly SessionModelQueueRow[]): Map<string, Message> {
  const out = new Map<string, Message>();
  for (const row of queue) {
    if (row.runId === null) continue;
    // 一个 Run 只由一个输入触发；先到者为准（同 run 的重复行不该出现）。
    if (out.has(row.runId)) continue;
    try {
      out.set(row.runId, JSON.parse(row.message) as Message);
    } catch {
      /* 解析不了的输入不进模型，但也不该拖垮整轮。 */
    }
  }
  return out;
}

function mapPendingActions(
  actions: readonly SessionModelPendingActionRow[],
): Map<string, CanonicalInputRequest[]> {
  const out = new Map<string, CanonicalInputRequest[]>();
  for (const action of actions) {
    const request: CanonicalInputRequest = {
      requestId: action.actionId,
      kind: action.kind,
      status: actionStatus(action.status),
      ...(toolCallIdOf(action.payload) !== undefined
        ? { toolCallId: toolCallIdOf(action.payload)! }
        : {}),
      ...(action.response !== undefined && action.response !== null
        ? { response: JSON.parse(action.response) as unknown }
        : {}),
    };
    const list = out.get(action.runId);
    if (list) list.push(request);
    else out.set(action.runId, [request]);
  }
  return out;
}

/** 审批的 payload 里记着它针对的调用 id（`callId` 或 `toolCallId`）。 */
function toolCallIdOf(payload: string): string | undefined {
  try {
    const parsed = JSON.parse(payload) as { callId?: unknown; toolCallId?: unknown };
    const id = parsed.toolCallId ?? parsed.callId;
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
}

function actionStatus(status: string): CanonicalInputRequest["status"] {
  if (status === "resolved" || status === "cancelled") return status;
  return "pending";
}

/** Run 状态到轮次状态。`aborted` 对 AHP 的 `cancelled`，两者是同一件事：人叫停
 *  或机器中断，都不是失败。 */
export function turnStatus(status: string): CanonicalTurnStatus {
  switch (status) {
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "aborted":
      return "cancelled";
    case "failed":
    case "commit_failed":
    case "timeout":
      return "failed";
    default:
      return "running";
  }
}
