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

export interface TodoItem {
  text: string;
  status: "pending" | "in_progress" | "completed";
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

export interface RunCardState {
  phase: "queued" | "thinking" | "tool_running" | "streaming";
  /** Live HITL wait: set by approval/ask events, cleared by the next
   * content event or a resolve callback. */
  waiting: "approval" | "ask" | null;
  pendingAction: PendingActionState | null;
  output: string;
  activeTool: ActiveTool | null;
  completedTools: CompletedTool[];
  todos: TodoItem[];
  terminal: { status: "completed" | "failed" | "cancelled"; error: string | null } | null;
}

const MAX_COMPLETED_TOOLS = 10;
const MAX_TODOS = 8;

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

export function summarizeTool(name: string | undefined): string {
  const LABELS: Record<string, string> = {
    read: "读取文件",
    write: "写入文件",
    edit: "修改文件",
    bash: "执行命令",
    grep: "搜索代码",
    glob: "查找文件",
    web: "访问网页",
    eval: "运行脚本",
  };
  const key = (name ?? "").split("/").pop() ?? "";
  return LABELS[key] ?? `调用 ${key || "工具"}`;
}

export interface RunStreamEvent {
  type: string;
  status?: string;
  error?: string;
  text?: string;
  toolName?: string;
  callId?: string;
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

/** Parse todo items from the wire payload (items is unknown[]). */
function parseTodoItems(items: unknown): TodoItem[] {
  if (!Array.isArray(items)) return [];
  const STATUS_MAP: Record<string, TodoItem["status"]> = {
    pending: "pending",
    in_progress: "in_progress",
    completed: "completed",
  };
  const todos: TodoItem[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const text = "text" in item && typeof item.text === "string" ? item.text : null;
    const status =
      "status" in item && typeof item.status === "string" ? STATUS_MAP[item.status] : undefined;
    if (text !== null && status !== undefined) todos.push({ text, status });
  }
  return todos.slice(0, MAX_TODOS);
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
      return {
        ...state,
        phase: "tool_running",
        waiting: null,
        pendingAction: null,
        activeTool: { label: summarizeTool(ev.toolName), startedAt: Date.now() },
      };
    }
    case "native_tool_completed": {
      const completed = [
        ...state.completedTools,
        {
          label: summarizeTool(ev.toolName),
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
