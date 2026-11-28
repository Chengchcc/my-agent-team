import type { CodingTerminalRow, CodingWorkspaceRow } from "@/lib/api";
import { buildCodingUrl } from "./locate";

export type CodingNotifyPref = "on" | "muted";

const PREF_KEY = "coding-notify-pref";
const PREF_EVENT = "coding-notify-pref-change";

export interface TerminalSnapshot {
  status: string;
  agentState?: string;
  kind: string;
}

export interface WorkspaceSnapshot {
  state: string;
  pendingActionCount: number;
  activeRunIds: readonly string[];
}

export interface CodingNotice {
  id: string;
  kind: "completed" | "blocked";
  source: "pty" | "acp";
  /** Unlocalized key + interpolation params so callers pass through `t()`. */
  titleKey: string;
  titleVars: Record<string, string | number>;
  bodyKey: string;
  bodyVars: Record<string, string | number>;
  href: string;
  terminalId?: string;
  workspaceId?: string;
}

export function readNotifyPref(): CodingNotifyPref {
  if (typeof window === "undefined") return "on";
  try {
    return window.localStorage.getItem(PREF_KEY) === "muted" ? "muted" : "on";
  } catch {
    return "on";
  }
}

export function writeNotifyPref(pref: CodingNotifyPref): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREF_KEY, pref);
  } catch {
    /* ignore storage errors in private mode */
  }
  window.dispatchEvent(new CustomEvent(PREF_EVENT, { detail: pref }));
}

export function subscribeNotifyPref(cb: (pref: CodingNotifyPref) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (ev: Event) => {
    const detail = (ev as CustomEvent<CodingNotifyPref>).detail;
    cb(detail === "muted" ? "muted" : "on");
  };
  window.addEventListener(PREF_EVENT, handler);
  return () => window.removeEventListener(PREF_EVENT, handler);
}

export function snapshotTerminals(
  terminals: readonly CodingTerminalRow[],
): Map<string, TerminalSnapshot> {
  const map = new Map<string, TerminalSnapshot>();
  for (const term of terminals) {
    map.set(term.terminalId, {
      status: term.status,
      agentState: term.agentState,
      kind: term.kind,
    });
  }
  return map;
}

export function snapshotWorkspaces(
  workspaces: readonly CodingWorkspaceRow[],
): Map<string, WorkspaceSnapshot> {
  const map = new Map<string, WorkspaceSnapshot>();
  for (const ws of workspaces) {
    map.set(ws.workspaceId, {
      state: ws.state,
      pendingActionCount: ws.pendingActionCount,
      activeRunIds: ws.activeRuns.map((r) => r.runId),
    });
  }
  return map;
}

/** Detect user-actionable transitions on interactive PTY coding agents (ADR 0083 D7):
 *  - `working` → `idle`: agent finished its turn
 *  - `running` (non-shell harness) → `exited`: agent session finished/exited
 *  - `*` → `blocked`: agent hit an approval/confirmation prompt */
export function detectTerminalNotices(
  prev: ReadonlyMap<string, TerminalSnapshot> | null,
  next: readonly CodingTerminalRow[],
): CodingNotice[] {
  if (prev === null) return [];
  const notices: CodingNotice[] = [];

  for (const term of next) {
    const before = prev.get(term.terminalId);
    if (!before) continue;

    const label =
      term.labels?.requirementTitle ??
      term.labels?.projectName ??
      term.labels?.agentName ??
      term.title;
    const harness = term.kind === "shell" ? term.title : term.kind;
    const href = buildCodingUrl({
      terminalId: term.terminalId,
      requirementId: term.requirementId,
      conversationId: term.conversationId,
      projectId: term.projectId,
    });

    if (
      term.status === "running" &&
      term.agentState === "blocked" &&
      before.agentState !== "blocked"
    ) {
      notices.push({
        id: `pty-blocked:${term.terminalId}`,
        kind: "blocked",
        source: "pty",
        titleKey: "{harness} needs input",
        titleVars: { harness },
        bodyKey: "{label} is waiting for your approval or reply.",
        bodyVars: { label },
        href,
        terminalId: term.terminalId,
        workspaceId: term.workspaceId ?? undefined,
      });
      continue;
    }

    const finishedTurn =
      before.agentState === "working" && term.status === "running" && term.agentState === "idle";
    const harnessExited =
      before.status === "running" && before.kind !== "shell" && term.status === "exited";

    if (finishedTurn || harnessExited) {
      notices.push({
        id: `pty-done:${term.terminalId}`,
        kind: "completed",
        source: "pty",
        titleKey: "{harness} finished",
        titleVars: { harness },
        bodyKey: "{label} completed its turn and is ready to review.",
        bodyVars: { label },
        href,
        terminalId: term.terminalId,
        workspaceId: term.workspaceId ?? undefined,
      });
    }
  }

  return notices;
}

/** Detect ACP worker completion or approval-blocked transitions per workspace (ADR 0083 D7).
 *  Skips workspaces already notified by a PTY transition in the same tick. */
export function detectWorkspaceRunNotices(
  prev: ReadonlyMap<string, WorkspaceSnapshot> | null,
  next: readonly CodingWorkspaceRow[],
  notifiedWorkspaceIds: ReadonlySet<string>,
): CodingNotice[] {
  if (prev === null) return [];
  const notices: CodingNotice[] = [];

  for (const ws of next) {
    if (notifiedWorkspaceIds.has(ws.workspaceId)) continue;
    const before = prev.get(ws.workspaceId);
    if (!before) continue;

    const label = ws.requirementTitle ?? ws.branch;
    const codingHref = buildCodingUrl({
      requirementId: ws.requirementId,
      conversationId: ws.conversationId,
      projectId: ws.projectId,
    });

    // Newly blocked by an ACP pending approval.
    if (ws.pendingActionCount > before.pendingActionCount) {
      const waitingRun = ws.activeRuns.find(
        (r) => r.status === "waiting" || r.pendingActionCount > 0,
      );
      const href = waitingRun
        ? `/chat/${encodeURIComponent(waitingRun.conversationId)}`
        : ws.conversationId
          ? `/chat/${encodeURIComponent(ws.conversationId)}`
          : codingHref;
      notices.push({
        id: `acp-blocked:${ws.workspaceId}:${ws.pendingActionCount}`,
        kind: "blocked",
        source: "acp",
        titleKey: "Worker waiting for approval",
        titleVars: {},
        bodyKey: "{label} has a pending decision in Conversation.",
        bodyVars: { label },
        href,
        workspaceId: ws.workspaceId,
      });
      continue;
    }

    // Active ACP runs dropped to zero after running -> worker finished!
    if (before.activeRunIds.length > 0 && ws.activeRuns.length === 0) {
      notices.push({
        id: `acp-done:${ws.workspaceId}:${before.activeRunIds[0] ?? "run"}`,
        kind: "completed",
        source: "acp",
        titleKey: "Worker finished",
        titleVars: {},
        bodyKey: "{label} finished executing in workspace.",
        bodyVars: { label },
        href: codingHref,
        workspaceId: ws.workspaceId,
      });
    }
  }

  return notices;
}
