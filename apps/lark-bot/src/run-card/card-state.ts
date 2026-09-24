/**
 * ADR 0031: pure reducer from Run SSE events to the card's display state.
 * Kept free of I/O so the whole projection is unit-testable.
 *
 * Process view (2026-09-24): loop events are FOLDED, never mirrored —
 * thinking shows a phase word only (raw reasoning never reaches Lark),
 * tools archive as summarized completed steps (capped), text_delta is the
 * single streaming surface.
 */

export interface ActiveTool {
  label: string;
  startedAt: number;
}

export interface CompletedTool {
  label: string;
  outcome: "success" | "error";
}

export interface RunCardState {
  phase: "queued" | "thinking" | "tool_running" | "streaming";
  /** Live HITL wait: set by approval/ask events, cleared by the next
   * content event (backend does not broadcast an explicit resolve). */
  waiting: "approval" | "input" | null;
  /** CallId of the pending approval — powers the 批准/拒绝 buttons. */
  approvalCallId: string | null;
  output: string;
  activeTool: ActiveTool | null;
  completedTools: CompletedTool[];
  terminal: { status: "completed" | "failed" | "cancelled"; error: string | null } | null;
}

/** Runtime cap on archived steps (renderer shows the recent tail). */
const MAX_COMPLETED_TOOLS = 10;

export function initialRunCardState(): RunCardState {
  return {
    phase: "queued",
    waiting: null,
    approvalCallId: null,
    output: "",
    activeTool: null,
    completedTools: [],
    terminal: null,
  };
}

/** Run statuses that end the card lifecycle (anything else keeps it live;
 * `waiting` is display-only here — the durable fact lives in backend). */
const TERMINAL_RUN_STATUSES: Record<string, "completed" | "failed" | "cancelled"> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  aborted: "cancelled",
  commit_failed: "failed",
};

/** User-language tool label. The wire event carries only the tool name
 * today (mapping.ts) — parameter-level summaries need a protocol
 * extension (reserved); names already read like actions. */
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
  payload?: { callId?: string; toolName?: string; questions?: unknown } | undefined;
}

/** True when the completed tool's result reports an error. */
function isErrorResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  return "isError" in result && result.isError === true;
}

/** Fold one Run SSE event into the state. Returns the next state. */
export function applyRunEvent(state: RunCardState, ev: RunStreamEvent): RunCardState {
  if (state.terminal) return state;

  switch (ev.type) {
    case "status": {
      const mapped = ev.status ? TERMINAL_RUN_STATUSES[ev.status] : undefined;
      if (mapped) {
        return {
          ...state,
          waiting: null,
          activeTool: null,
          terminal: { status: mapped, error: ev.error ?? null },
        };
      }
      if (ev.status === "running") return { ...state, phase: "streaming" };
      return state;
    }
    // Raw reasoning never reaches the card: phase word only.
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
      // Any content means the HITL wait is over.
      return state.waiting !== null || state.activeTool !== null
        ? { ...next, waiting: null, activeTool: null, approvalCallId: null }
        : next;
    }
    case "native_tool_started": {
      return {
        ...state,
        phase: "tool_running",
        waiting: null,
        activeTool: {
          label: summarizeTool(ev.toolName),
          startedAt: Date.now(),
        },
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
      return { ...state, phase: "streaming", waiting: "approval", approvalCallId: callId };
    }
    case "backend.oma.ask_requested": {
      return { ...state, phase: "streaming", waiting: "input" };
    }
    default:
      return state;
  }
}
