import type { CodingAgentState } from "./agent-status.js";

/** Rolled-up status for a workspace row in the Herdr-style Coding sidebar (ADR 0083 D2). */
export type WorkspaceRollupState = "blocked" | "working" | "running" | "idle" | "exited" | "empty";

/** How long after the last PTY byte a non-oma harness pane still counts as "working". */
export const DEFAULT_PTY_ACTIVE_WINDOW_MS = 4_000;

// CSI sequences (ESC[...), OSC sequences (ESC]...BEL/ST), and 2-byte ESC sequences.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ANSI_OSC_RE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");
const ANSI_CSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const ANSI_ESC_RE = new RegExp(`${ESC}[@-Z\\\\-_]`, "g");

/** Strip ANSI escape sequences and normalize carriage-return redraws for text inspection. */
export function stripAnsi(input: string): string {
  const clean = input
    .replace(ANSI_OSC_RE, "")
    .replace(ANSI_CSI_RE, "")
    .replace(ANSI_ESC_RE, "")
    .replaceAll("\r\n", "\n");
  // For inline progress bars using bare `\r`, keep only the final overwrite of each line.
  return clean
    .split("\n")
    .map((line) => {
      const idx = line.lastIndexOf("\r");
      return idx === -1 ? line : line.slice(idx + 1);
    })
    .join("\n");
}

const BLOCKED_PROMPT_PATTERNS: readonly RegExp[] = [
  /\(\s*y\s*\/\s*n\s*\)/i,
  /\[\s*y\s*\/\s*n\s*\]/i,
  /\[\s*y\s*\/\s*n\s*\/\s*[a-z]+\s*\]/i,
  /\b(?:allow once|allow always|yes,\s*allow|do you want to (?:proceed|allow|run|continue|apply)|approve (?:this|tool|command|action)|permission required|waiting for (?:approval|confirmation)|confirm (?:execution|action)|press enter to continue)\b/i,
];

/** Infer semantic agent state for interactive non-oma CLI harnesses (`claude`, `pi`, `omp`)
 *  from PTY ring-buffer tail and output recency (ADR 0083 D4).
 *
 *  `oma` panes continue to use the authoritative `.oma/agent-status.json` file contract
 *  (ADR 0029) and do not pass through this heuristic. */
export function inferPtyHarnessState(input: {
  recentOutput: string;
  lastOutputAt: number | null;
  now?: number;
  activeWindowMs?: number;
}): CodingAgentState | undefined {
  if (input.lastOutputAt === null) return undefined;
  const now = input.now ?? Date.now();
  const activeWindowMs = input.activeWindowMs ?? DEFAULT_PTY_ACTIVE_WINDOW_MS;

  const stripped = stripAnsi(input.recentOutput);
  const nonEmptyLines = stripped
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const tailLines = nonEmptyLines.slice(-6);
  const tailBlock = tailLines.join("\n");

  if (tailBlock.length > 0 && BLOCKED_PROMPT_PATTERNS.some((re) => re.test(tailBlock))) {
    return "blocked";
  }

  if (now - input.lastOutputAt < activeWindowMs) {
    return "working";
  }

  return "idle";
}

const ROLLUP_RANK: Record<WorkspaceRollupState, number> = {
  blocked: 0,
  working: 1,
  running: 2,
  idle: 3,
  exited: 4,
  empty: 5,
};

export function workspaceRollupRank(state: WorkspaceRollupState): number {
  return ROLLUP_RANK[state];
}

/** Combine active ACP worker runs and live PTY terminals into one workspace status (ADR 0083 D2).
 *  Priority: blocked > working > running > idle > exited > empty. */
export function rollupWorkspaceState(input: {
  activeRuns: ReadonlyArray<{ status: string; pendingActionCount: number }>;
  terminals: ReadonlyArray<{ status: string; agentState?: string }>;
}): WorkspaceRollupState {
  if (
    input.activeRuns.some((r) => r.status === "waiting" || r.pendingActionCount > 0) ||
    input.terminals.some((t) => t.status === "running" && t.agentState === "blocked")
  ) {
    return "blocked";
  }
  if (
    input.activeRuns.some((r) => r.status === "running") ||
    input.terminals.some((t) => t.status === "running" && t.agentState === "working")
  ) {
    return "working";
  }
  if (input.terminals.some((t) => t.status === "running" && !t.agentState)) {
    return "running";
  }
  if (input.terminals.some((t) => t.status === "running" && t.agentState === "idle")) {
    return "idle";
  }
  if (input.terminals.length > 0) {
    return "exited";
  }
  return "empty";
}
