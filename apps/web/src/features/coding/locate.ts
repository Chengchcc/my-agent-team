/** `?locate=1` on the coding page: find the terminal a link means, or say why there is none.
 *  Locating never creates anything; the page offers a separate Create button on a miss. */
import type { CodingTerminalRow } from "@/lib/api";

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
  /** A task-worktree path; absent means the project's main worktree. */
  worktreePath?: string;
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
  if (wanted !== null && pool !== main) selection.worktreePath = terminal.cwd;
  return { ok: true, terminal, selection };
}
