import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Task-worktree helpers shared by the coding surface (list + path
 *  validation). Layout contract with features/project/worktree.ts:
 *  `<agentWorkspace>/projects/<projectId>.<slug>`. */

export interface TaskWorktree {
  agentId: string;
  slug: string;
  path: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/i;

/** Every task worktree of a project across the given agents (fs scan of
 *  each agent's projects dir; main worktrees have no `.` suffix). */
export function listTaskWorktrees(
  projectId: string,
  agents: ReadonlyArray<{ id: string; workspacePath: string }>,
): TaskWorktree[] {
  const out: TaskWorktree[] = [];
  const prefix = `${projectId}.`;
  for (const agent of agents) {
    const dir = join(agent.workspacePath, "projects");
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // agent has no projects dir yet
    }
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const slug = entry.slice(prefix.length);
      if (!SLUG_RE.test(slug)) continue;
      const full = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      out.push({ agentId: agent.id, slug, path: full });
    }
  }
  return out;
}

/** A spawn's worktreePath must be exactly the agent's main worktree or one
 *  of its task worktrees — never an arbitrary cwd (terminal = code
 *  execution). Returns the validated path. */
export function validateWorktreePath(
  agentWorkspace: string,
  projectId: string,
  worktreePath: string | undefined,
): string | undefined {
  if (worktreePath === undefined) return undefined;
  const main = join(agentWorkspace, "projects", projectId);
  if (worktreePath === main) return worktreePath;
  const prefix = `${main}.`;
  const slug = worktreePath.slice(prefix.length);
  if (!worktreePath.startsWith(prefix) || !SLUG_RE.test(slug)) {
    throw new Error("worktreePath must be this agent's main or task worktree");
  }
  return worktreePath;
}
