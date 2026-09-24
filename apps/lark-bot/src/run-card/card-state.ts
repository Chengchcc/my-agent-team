import type { OmaTodoItem as OmaTodoItemType } from "@chengchenccc/api-contract";
import { hasDedicatedEvent, OmaTodoItem } from "@chengchenccc/api-contract";

/**
 * ADR 0031: pure reducer from Run SSE events to the card's display state.
 * Kept free of I/O so the whole projection is unit-testable.
 *
 * Process view: loop events are FOLDED, never mirrored — thinking shows a
 * phase word only, tools archive as summarized completed steps, text_delta
 * is the single streaming surface. Todo and ask come from oma product
 * tools via backend (never parsed from text_delta by the Lark surface).
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
}

export interface PendingActionState {
  callId: string;
  kind: "ask" | "approval";
  /** The user-facing prompt (question or approval reason). */
  prompt: string;
  /** Select options for ask questions (kind=select only). */
  options: AskOption[];
  /** Whether a free-text input row should be offered. */
  allowFreeText: boolean;
  /** The question item id (for the resolve payload). */
  questionId: string;
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
      prompt: "",
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

const TERMINAL_RUN_STATUSES: Record<string, "completed" | "failed" | "cancelled"> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  aborted: "cancelled",
  commit_failed: "failed",
};

/** The line shown for a tool call. The child sends an activity string it
 *  authored and sanitized (oma `Tool.describeStart`); when a tool cannot
 *  describe itself, the tool name is the only honest thing left — the card
 *  must never synthesize a summary from the name (that is how a surface
 *  starts claiming it knows what a tool is doing). */
export function toolActivity(activity: string | undefined, name: string | undefined): string {
  if (activity) return activity;
  const raw = name ?? "";
  const mcp = /^mcp__(.+?)__(.+)$/.exec(raw);
  if (mcp) return `正在调用 ${mcp[1]} · ${mcp[2]}`;
  return `正在调用 ${raw || "工具"}`;
}

export interface RunStreamEvent {
  type: string;
  status?: string;
  error?: string;
  text?: string;
  toolName?: string;
  callId?: string;
  activity?: string;
  result?: unknown;
  payload?:
    | {
        callId?: string;
        toolName?: string;
        questions?: unknown;
        items?: unknown;
      }
    | undefined;
}

function isErrorResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  return "isError" in result && result.isError === true;
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
      if (label !== null && value !== null) options.push({ label, value });
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

export function applyRunEvent(state: RunCardState, ev: RunStreamEvent): RunCardState {
  if (state.terminal) return state;

  switch (ev.type) {
    case "status": {
      const mapped = ev.status ? TERMINAL_RUN_STATUSES[ev.status] : undefined;
      if (mapped) {
        return {
          ...state,
          waiting: null,
          pendingAction: null,
          activeTool: null,
          terminal: { status: mapped, error: ev.error ?? null },
        };
      }
      if (ev.status === "running") return { ...state, phase: "streaming" };
      return state;
    }
    case "thinking_delta": {
      return state.activeTool === null && state.phase !== "thinking"
        ? { ...state, phase: "thinking" }
        : state;
    }
    case "text_delta": {
      const next: RunCardState = {
        ...state,
        phase: "streaming",
        output: state.output + (ev.text ?? ""),
      };
      return state.waiting !== null || state.activeTool !== null
        ? { ...next, waiting: null, pendingAction: null, activeTool: null }
        : next;
    }
    case "native_tool_started": {
      // Product tools own a dedicated event; a generic step for them would
      // be the "正在调用 todo_write" degradation. The wire name is MCP-qualified.
      if (hasDedicatedEvent(ev.toolName)) return state;
      return {
        ...state,
        phase: "tool_running",
        waiting: null,
        pendingAction: null,
        activeTool: {
          label: toolActivity(ev.activity, ev.toolName),
          startedAt: Date.now(),
        },
      };
    }
    case "native_tool_completed": {
      if (hasDedicatedEvent(ev.toolName)) return state;
      const completed = [
        ...state.completedTools,
        {
          label: toolActivity(ev.activity, ev.toolName),
          outcome: isErrorResult(ev.result) ? ("error" as const) : ("success" as const),
        },
      ].slice(-MAX_COMPLETED_TOOLS);
      return { ...state, activeTool: null, completedTools: completed };
    }
    case "backend.oma.approval_request": {
      const callId = ev.payload?.callId ?? null;
      if (!callId) return state;
      return {
        ...state,
        phase: "streaming",
        waiting: "approval",
        pendingAction: {
          callId,
          kind: "approval",
          prompt: "",
          options: [],
          allowFreeText: false,
          questionId: "",
        },
      };
    }
    case "backend.oma.ask_requested": {
      const callId = ev.payload?.callId ?? null;
      const parsed = parseAskQuestion(ev.payload?.questions);
      if (!callId || !parsed) return state;
      return {
        ...state,
        phase: "streaming",
        waiting: "ask",
        pendingAction: { ...parsed, callId },
      };
    }
    case "backend.oma.todo_update": {
      const todos = parseTodoItems(ev.payload?.items);
      if (todos.length === 0) return state;
      return { ...state, todos };
    }
    default:
      return state;
  }
}
