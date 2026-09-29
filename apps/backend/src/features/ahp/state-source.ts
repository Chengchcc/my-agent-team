/** AHP 状态源的产品实现（ADR 0040 决策一、四）。
 *
 *  这是一条**只读投影**：会话状态来自 agent 与工作区，chat 状态来自规范模型
 *  （`buildTurns`），后者只吃账本、队列与待处理动作三类事实。这里不写任何东西，
 *  产品侧的新事实仍由控制面派发（`dispatch`）。
 *
 *  粒度对齐（ADR 0040 决策三）：session = agent 加工作区，chat = conversation，
 *  turn = Run（`turnId = runId`），片段顺序与工具调用的配对都由规范模型决定。
 *
 *  上游的 const enum 在 `isolatedModules` 下不能取成员，所以状态值写成线上字面量
 *  并只对该值做断言；对象形状不做整体断言，缺字段由编译器指出。 */

import {
  AHP_CHAT_PREFIX,
  AHP_SESSION_PREFIX,
  chatUri,
  conversationIdFrom,
} from "@chengchenccc/ahp-client";
import type {
  CanonicalInputRequest,
  CanonicalPart,
  CanonicalToolCall,
} from "@chengchenccc/message";
import type {
  Message as AhpMessage,
  Turn as AhpTurn,
  ChatInputRequest,
  ChatState,
  ChatSummary,
  ErrorResponsePart,
  InputRequestResponsePart,
  MarkdownResponsePart,
  ReasoningResponsePart,
  ResponsePart,
  RootState,
  SessionState,
  SessionStatus,
  SystemNotificationResponsePart,
  ToolCallResponsePart,
  ToolCallState,
  URI,
} from "@microsoft/agent-host-protocol";
import {
  buildTurns,
  canonicalRunIds,
  type SessionModelRunRow,
} from "../conversation/session-model.js";
import type { AhpStateSource } from "./protocol.js";

/** `SessionStatus` 位掩码的线上值（上游 const enum 成员的数值）。 */
const IDLE = 1 as SessionStatus;
const ERROR = 2 as SessionStatus;
const IN_PROGRESS = 8 as SessionStatus;
const INPUT_NEEDED = 24 as SessionStatus;

/** 上游的 const enum 在 `isolatedModules` 下取不到成员，而普通字面量又不被接受：
 *  在**类型级**取成员（`X["kind"]` 合法），只在**值级**做一次断言，字段仍由编译器查。 */
function enumValue<T>(value: string): T {
  return value as unknown as T;
}

export interface AhpAgentRow {
  readonly id: string;
  readonly name: string;
  readonly runtime: string;
  readonly modelId: string;
}

export interface AhpConversationRow {
  readonly conversationId: string;
  readonly agentId: string | null;
  readonly title: string | null;
  readonly lastActivityAt?: number | null;
}

export interface AhpLedgerRow {
  readonly seq: number;
  readonly content?: unknown;
  /** 读库路径必带；实时推送路径的派生事件没有，缺省视为「不入任何轮次」。 */
  readonly agentRunId?: string | null;
  readonly messageIndex?: number;
  readonly ts: number;
}

export interface AhpRunRow {
  readonly runId: string;
  readonly status: string;
  readonly createdAt: number;
}

/** 投影需要的产品读端口：都是只读查询。 */
export interface AhpStateSourceDeps {
  readonly listAgents: () => Promise<readonly AhpAgentRow[]>;
  readonly getConversation: (conversationId: string) => AhpConversationRow | null;
  readonly getLedgerEntries: (conversationId: string) => readonly AhpLedgerRow[];
  readonly listPendingInputs: (
    conversationId: string,
  ) => Promise<readonly { readonly runId: string | null; readonly message: string }[]>;
  readonly listPendingActions: (runId: string) => Promise<
    readonly {
      readonly actionId: string;
      readonly kind: string;
      readonly status: string;
      readonly payload: string;
      readonly response?: string | null;
    }[]
  >;
  readonly getRun: (runId: string) => Promise<AhpRunRow | null>;
}

export function createAhpStateSource(deps: AhpStateSourceDeps): AhpStateSource {
  return {
    root: async () => rootState(await deps.listAgents()),
    session: async (uri) => sessionState(deps, await deps.listAgents(), uri),
    chat: async (uri) => chatState(deps, await deps.listAgents(), uri),
  };
}

function rootState(agents: readonly AhpAgentRow[]): RootState {
  return {
    agents: agents.map((agent) => ({
      provider: agent.runtime,
      displayName: agent.name,
      // 原样带上，不做结构假设：模型标识是产品自己的字符串。
      description: agent.modelId,
      models: [],
    })),
  };
}

async function sessionState(
  deps: AhpStateSourceDeps,
  agents: readonly AhpAgentRow[],
  uri: URI,
): Promise<SessionState | undefined> {
  const conversationId = conversationIdFrom(uri, AHP_SESSION_PREFIX);
  if (conversationId === undefined) return undefined;
  const row = deps.getConversation(conversationId);
  if (!row) return undefined;
  const view = await chatView(deps, row);
  return {
    provider: providerOf(agents, row),
    title: row.title ?? row.conversationId,
    status: view.status,
    lifecycle: "ready" as SessionState["lifecycle"],
    // 目前没有客户端注册表：AHP 面还没有客户端能力上报的落点。
    activeClients: [],
    chats: [chatSummary(row, view)],
    defaultChat: chatUri(row.conversationId),
  };
}

async function chatState(
  deps: AhpStateSourceDeps,
  _agents: readonly AhpAgentRow[],
  uri: URI,
): Promise<ChatState | undefined> {
  const conversationId = conversationIdFrom(uri, AHP_CHAT_PREFIX);
  if (conversationId === undefined) return undefined;
  const row = deps.getConversation(conversationId);
  if (!row) return undefined;
  const view = await chatView(deps, row);
  return {
    resource: uri,
    title: row.title ?? row.conversationId,
    status: view.status,
    modifiedAt: isoOf(view.modifiedAt),
    turns: view.turns,
    ...(view.activeTurn ? { activeTurn: view.activeTurn } : {}),
  };
}

function chatSummary(row: AhpConversationRow, view: ChatView): ChatSummary {
  return {
    resource: chatUri(row.conversationId),
    title: row.title ?? row.conversationId,
    status: view.status,
    modifiedAt: isoOf(view.modifiedAt),
  };
}

function providerOf(agents: readonly AhpAgentRow[], row: AhpConversationRow): string {
  return agents.find((agent) => agent.id === row.agentId)?.runtime ?? "unknown";
}

interface ChatView {
  readonly turns: AhpTurn[];
  readonly activeTurn: ChatState["activeTurn"];
  readonly status: SessionStatus;
  readonly modifiedAt: number;
}

async function chatView(deps: AhpStateSourceDeps, row: AhpConversationRow): Promise<ChatView> {
  const conversationId = row.conversationId;
  const ledger = deps.getLedgerEntries(conversationId);
  const queue = await deps.listPendingInputs(conversationId);
  const runs = await Promise.all(
    canonicalRunIds({ ledger, queue }).map((runId) => deps.getRun(runId)),
  );
  const known = runs.filter((run): run is AhpRunRow => run !== null);

  // 动作按 run 成对取回，归属不靠猜。
  const paired = await Promise.all(
    known.map(async (run) =>
      (await deps.listPendingActions(run.runId)).map((action) => ({ runId: run.runId, action })),
    ),
  );

  const canonical = buildTurns({
    ledger: ledger.map((entry) => ({
      seq: entry.seq,
      conversationId,
      content: entry.content,
      agentRunId: entry.agentRunId ?? null,
      messageIndex: entry.messageIndex ?? 0,
    })),
    queue: queue.map((input, index) => ({
      inputId: `queue-${index}`,
      runId: input.runId,
      mode: "normal",
      message: input.message,
    })),
    runs: known.map(
      (run): SessionModelRunRow => ({
        runId: run.runId,
        status: run.status,
        createdAt: run.createdAt,
      }),
    ),
    pendingActions: paired.flat().map(({ runId, action }) => ({
      actionId: action.actionId,
      runId,
      kind: action.kind,
      status: action.status,
      payload: action.payload,
      response: action.response ?? null,
    })),
  });

  const startedAtOf = (turnId: string): number =>
    known.find((run) => run.runId === turnId)?.createdAt ?? 0;

  const turns: AhpTurn[] = [];
  let activeTurn: ChatState["activeTurn"];
  let waiting = false;
  for (const turn of canonical) {
    if (turn.status === "running" || turn.status === "waiting") {
      if (turn.status === "waiting") waiting = true;
      // 上游只允许一个在跑的轮次；产品保证同一会话同时只有一个 Run 在跑。
      activeTurn ??= {
        id: turn.turnId,
        startedAt: isoOf(startedAtOf(turn.turnId)),
        message: toAhpMessage(turn.input),
        responseParts: toResponseParts(turn.turnId, turn.parts),
        usage: undefined,
      };
      continue;
    }
    turns.push({
      id: turn.turnId,
      startedAt: isoOf(startedAtOf(turn.turnId)),
      message: toAhpMessage(turn.input),
      responseParts: toResponseParts(turn.turnId, turn.parts),
      usage: undefined,
      state: turnStateOf(turn.status),
    });
  }

  turns.push(...continuityTurns(ledger));
  // 续接记录来自账本里非消息的行，按时间插回正确位置。
  turns.sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));

  const status = activeTurn
    ? waiting
      ? INPUT_NEEDED
      : IN_PROGRESS
    : turns.at(-1)?.state === "error"
      ? ERROR
      : IDLE;

  return {
    turns,
    activeTurn,
    status,
    modifiedAt: row.lastActivityAt ?? newestTs(ledger) ?? 0,
  };
}

/** 续接记录（surface 写的那行「这条对话续到了新对话」）在 AHP 里落成一条系统提示
 *  轮次：上游的 `systemNotification` 来源就是为「转录连续性」设计的，surface 看到它
 *  就知道该把自己改绑到哪里。规范的 id 放在 `_meta`，文案由 surface 自己决定。 */
function continuityTurns(ledger: readonly AhpLedgerRow[]): AhpTurn[] {
  const out: AhpTurn[] = [];
  for (const row of ledger) {
    const notice = continuityNotice(row.content);
    if (!notice) continue;
    const text = "This conversation continued in a new one.";
    const part: SystemNotificationResponsePart = {
      kind: enumValue<SystemNotificationResponsePart["kind"]>("systemNotification"),
      content: text,
      _meta: {
        newConversationId: notice.newConversationId,
        requestedByRunId: notice.requestedByRunId,
      },
    };
    out.push({
      id: `continuity:${row.seq}`,
      startedAt: isoOf(row.ts),
      message: {
        text,
        origin: { kind: enumValue<AhpMessage["origin"]["kind"]>("systemNotification") },
      },
      responseParts: [part],
      usage: undefined,
      state: enumValue<AhpTurn["state"]>("complete"),
    });
  }
  return out;
}

function continuityNotice(
  content: unknown,
): { newConversationId: string; requestedByRunId: string } | undefined {
  try {
    const parsed = (typeof content === "string" ? JSON.parse(content) : content) as {
      newConversationId?: unknown;
      requestedByRunId?: unknown;
    } | null;
    const newConversationId = parsed?.newConversationId;
    const requestedByRunId = parsed?.requestedByRunId;
    if (typeof newConversationId !== "string" || typeof requestedByRunId !== "string") {
      return undefined;
    }
    return { newConversationId, requestedByRunId };
  } catch {
    return undefined;
  }
}

function turnStateOf(status: "completed" | "failed" | "cancelled"): AhpTurn["state"] {
  if (status === "completed") return "complete" as AhpTurn["state"];
  if (status === "cancelled") return "cancelled" as AhpTurn["state"];
  return "error" as AhpTurn["state"];
}

function newestTs(ledger: readonly AhpLedgerRow[]): number | undefined {
  let ts: number | undefined;
  for (const entry of ledger) {
    if (ts === undefined || entry.ts > ts) ts = entry.ts;
  }
  return ts;
}

function isoOf(ts: number): string {
  return new Date(ts).toISOString();
}

function toAhpMessage(
  input: { readonly role?: string; readonly text?: string } | undefined,
): AhpMessage {
  const role = input?.role ?? "user";
  const kind =
    role === "user"
      ? "user"
      : role === "assistant"
        ? "agent"
        : role === "tool"
          ? "tool"
          : "systemNotification";
  return {
    text: input?.text ?? "",
    origin: { kind: kind as AhpMessage["origin"]["kind"] },
  };
}

function toResponseParts(turnId: string, parts: readonly CanonicalPart[]): ResponsePart[] {
  return parts.map((part, index) => toResponsePart(turnId, part, index));
}

function toResponsePart(turnId: string, part: CanonicalPart, index: number): ResponsePart {
  switch (part.kind) {
    case "text": {
      const markdown: MarkdownResponsePart = {
        kind: enumValue<MarkdownResponsePart["kind"]>("markdown"),
        id: `${turnId}:text:${index}`,
        content: part.text,
        ...metaOf(part.messageId),
      };
      return markdown;
    }
    case "thinking": {
      const reasoning: ReasoningResponsePart = {
        kind: enumValue<ReasoningResponsePart["kind"]>("reasoning"),
        id: `${turnId}:reasoning:${index}`,
        content: part.text,
        ...metaOf(part.messageId),
      };
      return reasoning;
    }
    case "error": {
      const error: ErrorResponsePart = {
        kind: enumValue<ErrorResponsePart["kind"]>("error"),
        error: { errorType: part.code ?? "run_failed", message: part.message },
      };
      return error;
    }
    case "toolCall": {
      const call: ToolCallResponsePart = {
        kind: enumValue<ToolCallResponsePart["kind"]>("toolCall"),
        toolCall: toToolCall(part.toolCall),
      };
      return call;
    }
    case "inputRequest":
      return toInputRequestPart(part.request);
    default: {
      const unreachable: never = part;
      throw new Error(`unhandled canonical part: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** 账本的消息身份放在 `_meta` 里：surface 靠它做恰好一次投递。上游允许实现自定义
 *  元数据，这里只是把既有事实透出去，不发明结构。 */
function metaOf(messageId: string | undefined): { _meta?: Record<string, unknown> } {
  return messageId === undefined ? {} : { _meta: { messageId } };
}

function toInputRequestPart(request: CanonicalInputRequest): ResponsePart {
  const payload: ChatInputRequest = {
    id: request.requestId,
    message: request.kind,
    ...(request.response === undefined
      ? {}
      : // 上游 answers 的细化形状尚未核对，原始答复放 _meta，不发明结构。
        { _meta: { productResponse: request.response } }),
  };
  const kind = enumValue<InputRequestResponsePart["kind"]>("inputRequest");
  if (request.status === "pending") {
    const pending: InputRequestResponsePart = { kind, request: payload };
    return pending;
  }
  const response = inputOutcome(request);
  if (response === undefined) {
    const unresolved: InputRequestResponsePart = { kind, request: payload };
    return unresolved;
  }
  const resolved: InputRequestResponsePart = { kind, request: payload, response };
  return resolved;
}

/** 人工输入的结局。**不能只看 status**：拒绝与超时在 durable 记录里同样是
 *  `resolved`，只有答复内容分得清；形状不认识时宁可不表态，也不冒充「已接受」。 */
function inputOutcome(
  request: CanonicalInputRequest,
): InputRequestResponsePart["response"] | undefined {
  const kind = <T>(value: string): T => value as unknown as T;
  if (request.status === "cancelled") {
    return kind<NonNullable<InputRequestResponsePart["response"]>>("cancel");
  }
  if (request.status !== "resolved") return undefined;
  const answer = request.response as { decision?: unknown; timeout?: unknown } | null | undefined;
  if (answer?.timeout === true) {
    return kind<NonNullable<InputRequestResponsePart["response"]>>("decline");
  }
  if (answer?.decision === "allow") {
    return kind<NonNullable<InputRequestResponsePart["response"]>>("accept");
  }
  if (answer?.decision === "deny") {
    return kind<NonNullable<InputRequestResponsePart["response"]>>("decline");
  }
  return undefined;
}

type ToolCallPending = Extract<ToolCallState, { status: "pending-confirmation" }>;
type ToolCallRunning = Extract<ToolCallState, { status: "running" }>;
type ToolCallCancelled = Extract<ToolCallState, { status: "cancelled" }>;
type ToolCallCompleted = Extract<ToolCallState, { status: "completed" }>;

function toToolCall(call: CanonicalToolCall): ToolCallState {
  const input =
    typeof call.input === "string" ? call.input : (JSON.stringify(call.input ?? null) ?? "null");
  const base = {
    toolCallId: call.toolCallId,
    toolName: call.name,
    displayName: call.name,
  };
  const params = {
    invocationMessage: input.length > 200 ? `${input.slice(0, 200)}…` : input,
    toolInput: input,
  };
  const status = call.status;
  if (status === "pending") {
    const pending: ToolCallPending = {
      ...base,
      ...params,
      status: enumValue<ToolCallPending["status"]>("pending-confirmation"),
    };
    return pending;
  }
  const confirmed = enumValue<ToolCallCompleted["confirmed"]>("not-needed");
  if (status === "running") {
    const running: ToolCallRunning = {
      ...base,
      ...params,
      confirmed,
      status: enumValue<ToolCallRunning["status"]>("running"),
    };
    return running;
  }
  if (status === "cancelled") {
    const cancelled: ToolCallCancelled = {
      ...base,
      ...params,
      status: enumValue<ToolCallCancelled["status"]>("cancelled"),
      // 产品语义里 cancelled = 没跑过（跑动被叫停），不是被谁否决。
      reason: enumValue<ToolCallCancelled["reason"]>("skipped"),
    };
    return cancelled;
  }
  const success = status === "completed";
  const pastTenseMessage = success ? `${call.name} finished` : `${call.name} failed`;
  const completed: ToolCallCompleted = {
    ...base,
    ...params,
    confirmed,
    status: enumValue<ToolCallCompleted["status"]>("completed"),
    success,
    pastTenseMessage,
    ...(success ? {} : { error: { message: pastTenseMessage } }),
  };
  return completed;
}
