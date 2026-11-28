/** `?locate=1` on the coding page: find the terminal a link means, or say why there is none.
 *  Locating never creates anything; the page offers a separate Create button on a miss. */
import type { CodingHarness, CodingTerminalRow } from "@/lib/api";

export const CODING_HARNESS_OPTIONS: readonly CodingHarness[] = ["oma", "claude", "pi", "omp"];

export interface ResumeHint {
  tabHint?: string | null;
  savedTerminalId?: string | null;
  savedWorkspaceId?: string | null;
}

function terminalAttentionRank(term: CodingTerminalRow): number {
  if (term.status === "running" && term.agentState === "blocked") return 0;
  if (term.status === "running" && term.agentState === "working") return 1;
  if (term.status === "running" && term.kind !== "shell") return 2;
  if (term.status === "running") return 3;
  return 4;
}

/** Pick the best existing terminal to resume automatically when opening `/coding` (ADR 0083 D6).
 *  Order: URL `?t=` hint → last focused terminal → last focused workspace → highest-attention pane.
 *  Never spawns anything; returns null only when no terminals exist. */
export function pickResumeTerminal(
  terminals: readonly CodingTerminalRow[],
  hint: ResumeHint,
): CodingTerminalRow | null {
  if (terminals.length === 0) return null;
  if (hint.tabHint) {
    const byTab = terminals.find((x) => x.terminalId === hint.tabHint);
    if (byTab) return byTab;
  }
  if (hint.savedTerminalId) {
    const bySaved = terminals.find((x) => x.terminalId === hint.savedTerminalId);
    if (bySaved) return bySaved;
  }
  const sortByAttention = (pool: readonly CodingTerminalRow[]): CodingTerminalRow | null =>
    [...pool].sort((a, b) => {
      const diff = terminalAttentionRank(a) - terminalAttentionRank(b);
      if (diff !== 0) return diff;
      return b.startedAt - a.startedAt;
    })[0] ?? null;

  if (hint.savedWorkspaceId) {
    const inWorkspace = terminals.filter((x) => x.workspaceId === hint.savedWorkspaceId);
    if (inWorkspace.length > 0) return sortByAttention(inWorkspace);
  }
  return sortByAttention(terminals);
}

/** What a locate link names: a member, and optionally the project whose pane is meant. */
export interface LocateTarget {
  agentId: string;
  projectId?: string;
}

/** What a miss message needs from the registry: whether the member and the project exist. */
export interface LocateRegistry {
  agents: ReadonlyArray<{ id: string; name: string }>;
  projects: ReadonlyArray<{ projectId: string; name: string }>;
}

/** The scope the rail selects for the located pane. Same shape as the rail's `CodingSelection`. */
export interface LocateSelection {
  /** Absent means the member's own workspace (no project worktree). */
  projectId?: string;
  agentId: string;
  /** ADR 0077 requirement workspace id when anchored on a requirement checkout. */
  workspaceId?: string;
  /** A worktree path; absent means the project's main worktree. */
  worktreePath?: string;
  requirementId?: string;
  conversationId?: string;
}

export type LocateMissReason = "unknown-agent" | "unknown-project" | "no-terminal";

export type LocateMiss =
  | { reason: "unknown-agent" }
  | { reason: "unknown-project" }
  | {
      reason: "no-terminal";
      /** The member's terminals in other scopes, so the miss can say where they are. */
      elsewhere: CodingTerminalRow[];
    };

export type LocateResult =
  | { ok: true; terminal: CodingTerminalRow; selection: LocateSelection }
  | { ok: false; miss: LocateMiss };

/** Task-worktree cwd shape: `<...>/projects/<projectId>.<slug>` — the main worktree's last
 *  segment is exactly the projectId, with no dot suffix. */
export function isTaskWorktreeCwd(cwd: string): boolean {
  const last = cwd.split("/").pop() ?? "";
  return /^[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9-]{0,39}$/i.test(last);
}

/** Build a `/coding` URL while preserving dual-view context params (ADR 0083 D5). */
export function buildCodingUrl(params: {
  terminalId?: string | null;
  requirementId?: string | null;
  conversationId?: string | null;
  projectId?: string | null;
}): string {
  const sp = new URLSearchParams();
  if (params.requirementId) sp.set("requirement", params.requirementId);
  if (params.conversationId) sp.set("conversation", params.conversationId);
  if (params.projectId) sp.set("project", params.projectId);
  if (params.terminalId) sp.set("t", params.terminalId);
  const qs = sp.toString();
  return qs ? `/coding?${qs}` : "/coding";
}

/** Filter terminals belonging to the active Coding scope (workspace-first, then agent workspace). */
export function terminalsForSelection(
  terminals: readonly CodingTerminalRow[],
  selected: LocateSelection | null,
): CodingTerminalRow[] {
  if (!selected) return [];
  if (selected.workspaceId) {
    return terminals.filter(
      (x) =>
        x.workspaceId === selected.workspaceId ||
        (selected.worktreePath !== undefined && x.cwd === selected.worktreePath),
    );
  }
  return terminals.filter((x) => {
    if (x.agentId !== selected.agentId) return false;
    if (selected.projectId === undefined) {
      // ADR 0073: a workspace pane — no project, no worktree split.
      return x.projectId === null;
    }
    if (x.projectId !== selected.projectId) return false;
    return selected.worktreePath === undefined
      ? !isTaskWorktreeCwd(x.cwd)
      : x.cwd === selected.worktreePath;
  });
}

/** The terminal to focus for a locate link, or why none was found: no such member, no such
 *  project, or no terminal in that scope. A project scope prefers the main worktree's
 *  terminals; when the member only has task-worktree terminals there, one of them is located. */
export function resolveLocate(
  terminals: readonly CodingTerminalRow[],
  target: LocateTarget,
  registry: LocateRegistry,
): LocateResult {
  if (!registry.agents.some((agent) => agent.id === target.agentId)) {
    return { ok: false, miss: { reason: "unknown-agent" } };
  }
  const wanted = target.projectId === undefined ? null : target.projectId;
  if (wanted !== null && !registry.projects.some((project) => project.projectId === wanted)) {
    return { ok: false, miss: { reason: "unknown-project" } };
  }
  const mine = terminals.filter((row) => row.agentId === target.agentId);
  const inScope = mine.filter((row) => (row.projectId ?? null) === wanted);
  const miss: LocateResult = {
    ok: false,
    miss: { reason: "no-terminal", elsewhere: mine },
  };
  if (inScope.length === 0) return miss;

  const main = wanted === null ? inScope : inScope.filter((row) => !isTaskWorktreeCwd(row.cwd));
  const pool = main.length > 0 ? main : inScope;
  const first = inScope.at(0);
  const terminal = pool.at(0) ?? first;
  if (terminal === undefined) return miss;
  const selection: LocateSelection = { agentId: target.agentId };
  if (wanted !== null) selection.projectId = wanted;
  if (terminal.workspaceId) {
    selection.workspaceId = terminal.workspaceId;
    selection.worktreePath = terminal.cwd;
  } else if (wanted !== null && pool !== main) {
    selection.worktreePath = terminal.cwd;
  }
  if (terminal.requirementId) selection.requirementId = terminal.requirementId;
  if (terminal.conversationId) selection.conversationId = terminal.conversationId;
  return { ok: true, terminal, selection };
}
