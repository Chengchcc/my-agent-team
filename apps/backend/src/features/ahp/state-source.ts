/** The product's implementation of the AHP state source (ADR 0040, decisions 1 and 4).
 *
 *  This is a **read-only projection**: session state comes from the agent and its workspace,
 *  chat state from the canonical model (`buildTurns`), which itself reads only the ledger, the
 *  queue and pending actions. Nothing is written here; new product facts still arrive through the
 *
 *  control plane's `dispatch`, and granularity follows ADR 0040 decision 3: session = agent plus
 *  workspace, chat = conversation, turn = Run (`turnId = runId`), with part order and tool-call
 *
 *  pairing decided by the canonical model. Upstream's const enums cannot be indexed under
 *  `isolatedModules`, so state values are wire literals with only the value asserted; object
 *  shapes are never asserted wholesale, so a missing field is the compiler's to report. */

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

/** The wire values of the `SessionStatus` bitmask (upstream const-enum members). */
const IDLE = 1 as SessionStatus;
const ERROR = 2 as SessionStatus;
const IN_PROGRESS = 8 as SessionStatus;
const INPUT_NEEDED = 24 as SessionStatus;

/** Upstream's const enums cannot be indexed under `isolatedModules`, and a plain literal is not
 *  accepted either: take the member at **type** level (`X["kind"]` is legal) and assert once at
 *  **value** level, so fields still get checked by the compiler. */
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
  /** Always present on the database path; the live push path is a derived event without it,
   *  and an absent value means "belongs to no turn". */
  readonly agentRunId?: string | null;
  readonly messageIndex?: number;
  readonly ts: number;
}

export interface AhpRunRow {
  readonly runId: string;
  readonly status: string;
  readonly createdAt: number;
}

/** The read ports this projection needs. All of them are queries. */
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
  /** The run's latest todo snapshot (product tool output), or null when it never wrote one. */
  readonly latestRunTodo?: (runId: string) => Promise<string | null>;
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
      // Carry it through as-is, no structural assumptions: the model id is the product's string.
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
    // No client registry yet: the AHP face has nowhere to record advertised client capabilities.
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
  const todos = await activeTodos(deps, view.activeTurn?.id);
  return {
    resource: uri,
    title: row.title ?? row.conversationId,
    status: view.status,
    modifiedAt: isoOf(view.modifiedAt),
    turns: view.turns,
    ...(view.activeTurn ? { activeTurn: view.activeTurn } : {}),
    // The run's todo list is implementation metadata: a surface that renders it does not have to
    // listen to a second stream for it (the run-event feed it used to come from is being retired).
    ...(todos === undefined ? {} : { _meta: { todos } }),
  };
}

/** The active run's todo snapshot, as the product tool stored it (a JSON string). */
async function activeTodos(
  deps: AhpStateSourceDeps,
  runId: string | undefined,
): Promise<unknown[] | undefined> {
  if (runId === undefined || deps.latestRunTodo === undefined) return undefined;
  const snapshot = await deps.latestRunTodo(runId);
  if (snapshot === null || snapshot === "") return undefined;
  try {
    const parsed = JSON.parse(snapshot) as { items?: unknown; todos?: unknown };
    const list = Array.isArray(parsed) ? parsed : (parsed.items ?? parsed.todos);
    return Array.isArray(list) ? list : undefined;
  } catch {
    return undefined;
  }
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

  // Actions are fetched per run, so their attribution is not guessed.
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
      // Upstream allows one running turn; the product guarantees one running Run per conversation.
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
  // Continuity rows come from non-message ledger rows, so sort them back in by time.
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

/** The continuity record (the surface-written row saying this chat continued elsewhere) projects
 *  as a system-notification turn: upstream's `systemNotification` origin exists for transcript
 *  continuity, and a surface that sees it knows where to rebind. The canonical ids go in `_meta`;
 *  the wording stays the surface's business. */
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
  input: { readonly id?: string; readonly role?: string; readonly text?: string } | undefined,
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
    // The ledger identity again, on the initiating message: a surface dedupes its own optimistic
    // echo against it.
    ...(input?.id === undefined ? {} : { _meta: { messageId: input.id } }),
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

/** The ledger's message identity goes in `_meta`: a surface dedupes deliveries on it. Upstream
 *  allows implementation metadata, so this exposes a fact that already exists instead of
 *  inventing a field. */
function metaOf(messageId: string | undefined): { _meta?: Record<string, unknown> } {
  return messageId === undefined ? {} : { _meta: { messageId } };
}

function toInputRequestPart(request: CanonicalInputRequest): ResponsePart {
  const payload: ChatInputRequest = {
    id: request.requestId,
    message: request.kind,
    ...(request.response === undefined
      ? {}
      : // Upstream's answer shape is not verified yet, so the raw answer rides in _meta.
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

/** The outcome of a human input. **Status alone is not enough**: a refusal and a timeout are both
 *  `resolved` in the durable row, and only the answer tells them apart; an unrecognized shape is
 *  left unstated rather than passed off as an acceptance. */
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
      // In this product, cancelled means "never ran" (stopped mid-flight), not "denied".
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
