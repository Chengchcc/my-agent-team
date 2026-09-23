/**
 * ADR 0031: pure reducer from Run SSE events to the card's display state.
 * Kept free of I/O so the whole projection is unit-testable.
 */

export interface RunCardState {
  phase: "queued" | "running";
  /** Live HITL wait: set by approval/ask events, cleared by the next
   * content event (backend does not broadcast an explicit resolve). */
  waiting: "approval" | "input" | null;
  output: string;
  activeTool: string | null;
  toolCount: number;
  terminal: { status: "completed" | "failed" | "cancelled"; error: string | null } | null;
}

export function initialRunCardState(): RunCardState {
  return {
    phase: "queued",
    waiting: null,
    output: "",
    activeTool: null,
    toolCount: 0,
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

export interface RunStreamEvent {
  type: string;
  status?: string;
  error?: string;
  text?: string;
  toolName?: string;
  payload?: { callId?: string; toolName?: string; questions?: unknown } | undefined;
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
      if (ev.status === "running") return { ...state, phase: "running" };
      return state;
    }
    case "text_delta": {
      const next: RunCardState = {
        ...state,
        phase: "running",
        output: state.output + (ev.text ?? ""),
      };
      // Any content means the HITL wait is over.
      return state.waiting !== null || state.activeTool !== null
        ? { ...next, waiting: null, activeTool: null }
        : next;
    }
    case "native_tool_started": {
      const next: RunCardState = {
        ...state,
        phase: "running",
        waiting: null,
        activeTool: ev.toolName ?? "tool",
      };
      return next;
    }
    case "native_tool_completed": {
      return { ...state, activeTool: null, toolCount: state.toolCount + 1 };
    }
    case "backend.oma.approval_request": {
      return { ...state, phase: "running", waiting: "approval" };
    }
    case "backend.oma.ask_requested": {
      return { ...state, phase: "running", waiting: "input" };
    }
    default:
      return state;
  }
}
