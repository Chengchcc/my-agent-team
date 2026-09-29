import type { OmaTodoItem as OmaTodoItemType } from "@chengchenccc/api-contract";
import { hasDedicatedEvent, OmaTodoItem } from "@chengchenccc/api-contract";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { z } from "zod";

/**
 * ADR 0031: the card's display state, read out of the chat channel (ADR 0040 decision 4).
 * Kept free of I/O so the whole projection is unit-testable.
 *
 * Process view: a run is a turn, so the card mirrors what the protocol already folded rather
 * than re-deriving it — thinking shows a phase word only, tools archive as summarized completed
 * steps, and the markdown parts are the single streaming surface. Todo and ask arrive as parts
 * the projection typed (never parsed out of markdown by the Lark surface).
 */

export interface ActiveTool {
  label: string;
  startedAt: number;
}

export interface CompletedTool {
  label: string;
  outcome: "success" | "error";
}

export interface AskOption {
  label: string;
  value: string;
  /** Optional helper line the model attached to the option; the card shows it
   *  under the label so a choice reads as a choice. */
  description?: string;
}

export interface PendingActionState {
  callId: string;
  kind: "ask" | "approval";
  /** The user-facing prompt: an ask's question, an approval's ARGUMENT (the
   *  command / path being approved, never the internal reason text). */
  prompt: string;
  /** Approval only: the tool being approved, for the action-typed header. */
  toolName?: string;
  /** Approval only: the runtime's truthful OS-bash-sandbox signal. Security
   *  context belongs on the card that asks for the decision. */
  sandboxed?: boolean;
  /** Approval only: when this request fails closed (epoch ms). The card says
   *  it so the human is not guessing how long their click stays valid. */
  deadlineAt?: number;
  /** Select options for ask questions (kind=select only). */
  options: AskOption[];
  /** Whether a free-text input row should be offered. */
  allowFreeText: boolean;
  /** The question item id (for the resolve payload). */
  questionId: string;
}

/** The argument preview for an approval card — the command/path itself, in
 *  the shape the Web card shows (command first, JSON only as a fallback).
 *  Empty string when the payload carries nothing readable: the renderer then
 *  omits the block instead of printing `{}`. */
export function buildApprovalPrompt(payload: Record<string, unknown>): string {
  const input = payload.input;
  if (input === undefined || input === null) return "";
  // Truncation is always marked: a silently cut command would read as the
  // whole command, and the human approves what they can see.
  const clip = (text: string): string => (text.length > 400 ? `${text.slice(0, 400)}…` : text);
  if (typeof input === "string") return clip(input);
  // `in` narrowing, not a cast: the lark audit bans bare cross-process
  // assertions, and this payload came off the wire.
  if (typeof input === "object" && input !== null && "command" in input) {
    const command = input.command;
    if (typeof command === "string") return clip(command);
  }
  try {
    return clip(JSON.stringify(input));
  } catch {
    return clip(String(input));
  }
}

/** The tool's approval facts: name + sandbox truth, straight from the payload
 *  (the same record the durable restore reads). */
export function approvalFacts(payload: Record<string, unknown>): {
  toolName?: string;
  sandboxed?: boolean;
  deadlineAt?: number;
} {
  const facts: { toolName?: string; sandboxed?: boolean; deadlineAt?: number } = {};
  if (typeof payload.toolName === "string" && payload.toolName) facts.toolName = payload.toolName;
  if (typeof payload.sandboxed === "boolean") facts.sandboxed = payload.sandboxed;
  if (typeof payload.deadlineAt === "number" && payload.deadlineAt > 0) {
    facts.deadlineAt = payload.deadlineAt;
  }
  return facts;
}

/** "MM-DD HH:mm" in the reader's own timezone. Hand-formatted: no ICU, no
 *  locale surprises, and the same string in the tests wherever they run. */
export function formatDeadline(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Rebuild a pending action from the backend's durable record — the restart
 *  recovery path. Must produce EXACTLY what the live event reductions
 *  produce, so a restored card is indistinguishable from a live one. */
export function pendingActionFromBackend(
  kind: string,
  payload: Record<string, unknown>,
): PendingActionState | null {
  if (kind === "approval") {
    const callId = typeof payload.callId === "string" ? payload.callId : null;
    if (!callId) return null;
    return {
      callId,
      kind: "approval",
      prompt: buildApprovalPrompt(payload),
      ...approvalFacts(payload),
      options: [],
      allowFreeText: false,
      questionId: "",
    };
  }
  if (kind === "ask") {
    const callId = typeof payload.callId === "string" ? payload.callId : null;
    const parsed = parseAskQuestion(payload.questions);
    if (!callId || !parsed) return null;
    return { ...parsed, callId };
  }
  return null;
}

export interface RunCardState {
  phase: "queued" | "thinking" | "tool_running" | "streaming";
  /** Live HITL wait: set by approval/ask events, cleared by the next
   * content event or a resolve callback. */
  waiting: "approval" | "ask" | null;
  pendingAction: PendingActionState | null;
  output: string;
  activeTool: ActiveTool | null;
  completedTools: CompletedTool[];
  /** The oma todo plugin's snapshot, forwarded verbatim by the backend —
   *  vocabulary is the producer's (done/cancelled), not a card-local one. */
  todos: readonly OmaTodoItemType[];
  terminal: { status: "completed" | "failed" | "cancelled"; error: string | null } | null;
}

const MAX_COMPLETED_TOOLS = 10;
const MAX_TODOS = 50;

export function initialRunCardState(): RunCardState {
  return {
    phase: "queued",
    waiting: null,
    pendingAction: null,
    output: "",
    activeTool: null,
    completedTools: [],
    todos: [],
    terminal: null,
  };
}

/** The line shown for a tool call. The child sends an activity string it
 *  authored and sanitized (oma `Tool.describeStart`); when a tool cannot
 *  describe itself, the tool name is the only honest thing left — the card
 *  must never synthesize a summary from the name (that is how a surface
 *  starts claiming it knows what a tool is doing). */
export function toolActivity(
  activity: string | undefined,
  name: string | undefined,
  presentation?: { title: string; detail?: string; resultSummary?: string; errorSummary?: string },
): string {
  // The structured form first (title + detail), then the legacy line, then
  // the tool name.
  if (presentation) {
    const detail = presentation.resultSummary ?? presentation.errorSummary ?? presentation.detail;
    return detail ? `${presentation.title}：${detail}` : presentation.title;
  }
  if (activity) return activity;
  const raw = name ?? "";
  const mcp = /^mcp__(.+?)__(.+)$/.exec(raw);
  if (mcp) return `正在调用 ${mcp[1]} · ${mcp[2]}`;
  return `正在调用 ${raw || "工具"}`;
}

/** A plain object, or undefined. The contract audit bans bare casts in this app, so the shape is
 *  validated rather than asserted - which also means a payload that is not an object cannot
 *  reach the builders below. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  const parsed = PlainRecord.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const PlainRecord = z.record(z.string(), z.unknown());

/** The protocol lets an invocation message be a plain string or markdown; the card wants the
 *  line, so both forms fold to one. */
function invocationLine(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const markdown = recordOf(value)?.["markdown"];
  return typeof markdown === "string" ? markdown : undefined;
}

/** Parse todo items with the shared wire schema — the same definition the
 *  Web reducer relies on, so the two surfaces cannot drift apart. An item
 *  that fails validation is dropped rather than guessed at. */
function parseTodoItems(items: unknown): readonly OmaTodoItemType[] {
  if (!Array.isArray(items)) return [];
  const parsed: OmaTodoItemType[] = [];
  for (const item of items) {
    const result = OmaTodoItem.safeParse(item);
    if (result.success) parsed.push(result.data);
  }
  // Keep the tail: a long plan's active items are near the end, and the
  // renderer windows from the same end — capping the head showed stale
  // finished steps and hid the one that is running.
  return parsed.slice(-MAX_TODOS);
}

/** Parse the first select/text question from the ask payload. */
function parseAskQuestion(questions: unknown): PendingActionState | null {
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const q = questions[0];
  if (typeof q !== "object" || q === null) return null;
  const question = "question" in q && typeof q.question === "string" ? q.question : "";
  const questionId = "id" in q && typeof q.id === "string" ? q.id : "";
  const allowFreeText = "allowOther" in q && q.allowOther === true;
  const options: AskOption[] = [];
  if (Array.isArray(q.options)) {
    for (const opt of q.options) {
      if (typeof opt !== "object" || opt === null) continue;
      const label = "label" in opt && typeof opt.label === "string" ? opt.label : null;
      const value = "value" in opt && typeof opt.value === "string" ? opt.value : null;
      const description =
        "description" in opt && typeof opt.description === "string" ? opt.description : undefined;
      if (label !== null && value !== null)
        options.push({ label, value, ...(description ? { description } : {}) });
    }
  }
  const isText = "kind" in q && q.kind === "text";
  return {
    callId: "",
    kind: "ask",
    prompt: question,
    options: isText ? [] : options,
    allowFreeText: allowFreeText || isText,
    questionId,
  };
}

/** The card's state as the chat channel has it (ADR 0040 decision 4): the run is the turn, its
 *  markdown is the body, its tool calls are the steps, its still-open input request is the
 *  buttons, and the chat state's `_meta.todos` is the plan. A turn that has folded into `turns`
 *  is settled - that fold is the seal.
 *
 *  Read-only and total: it never guesses. A part it does not recognise is skipped, and an
 *  unanswered question is the only thing that puts buttons on the card. */
/** A run that settled without ever producing a turn: the state has nothing to read, and the card
 *  must not sit on "thinking" forever. The caller supplies the product fact - the run's status -
 *  because that is a run fact, not something the chat channel carries. */
export function terminalFromRunStatus(status: string | null | undefined): RunCardState["terminal"] {
  switch (status) {
    case "completed":
      return { status: "completed", error: null };
    case "failed":
    case "commit_failed":
      return { status: "failed", error: null };
    case "cancelled":
    case "aborted":
      return { status: "cancelled", error: null };
    default:
      return null;
  }
}

export function cardStateFromChatTurn(
  state: ChatState,
  runId: string,
  now = Date.now(),
): RunCardState | undefined {
  const committed = state.turns.find((t) => t.id === runId);
  const turn = state.activeTurn?.id === runId ? state.activeTurn : committed;
  if (!turn) return undefined;

  let output = "";
  let activeTool: ActiveTool | null = null;
  const completedTools: CompletedTool[] = [];
  let pendingAction: PendingActionState | null = null;
  let failure: string | null = null;

  for (const part of turn.responseParts) {
    const kind = part.kind as string;
    if (kind === "markdown") {
      if ("content" in part && typeof part.content === "string") output += part.content;
      continue;
    }
    if (kind === "error") {
      if ("error" in part && typeof part.error.message === "string") failure = part.error.message;
      continue;
    }
    if (kind === "toolCall" && "toolCall" in part) {
      const call = part.toolCall;
      if (hasDedicatedEvent(call.toolName)) continue;
      // The authored line first (the child's own `activity`), then what the protocol set on the
      // call itself; `toolActivity` synthesizes only when neither exists.
      const authored =
        call.intention ??
        invocationLine("invocationMessage" in call ? call.invocationMessage : undefined);
      const label = toolActivity(authored, call.toolName);
      const status = call.status as string;
      if (status === "running" || status === "pending-confirmation") {
        activeTool = { label, startedAt: now };
        continue;
      }
      const failed = "success" in call && call.success === false;
      const outcome = status === "completed" && !failed ? ("success" as const) : ("error" as const);
      completedTools.push({ label, outcome });
      continue;
    }
    if (kind === "inputRequest" && "request" in part) {
      // An answered request is not pending any more: the card stops offering it.
      if ("response" in part && part.response !== undefined) continue;
      const request = part.request;
      // `_meta` rides a shape upstream gives no slot to; the page records that convention.
      const requestMeta = recordOf(recordOf(request)?.["_meta"]);
      const payload = recordOf(requestMeta?.["productRequest"]);
      pendingAction = pendingActionFromBackend(request.message as string, payload ?? {});
    }
  }

  // Only a folded turn has a state; while it is active the run is still going.
  const turnState = committed === undefined ? undefined : (committed.state as string);
  const terminal: RunCardState["terminal"] =
    turnState === undefined
      ? null
      : {
          status:
            turnState === "complete"
              ? "completed"
              : turnState === "cancelled"
                ? "cancelled"
                : "failed",
          error: failure,
        };

  return {
    phase: pendingAction
      ? "streaming"
      : activeTool
        ? "tool_running"
        : output === ""
          ? "thinking"
          : "streaming",
    waiting: pendingAction ? pendingAction.kind : null,
    pendingAction,
    output,
    activeTool,
    completedTools: completedTools.slice(-MAX_COMPLETED_TOOLS),
    todos: parseTodoItems(state._meta?.todos),
    terminal,
  };
}
