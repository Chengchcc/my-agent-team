import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConflictError, NotFoundError, ValidationError } from "../../infra/domain-errors.js";

/** Project facts the worktree plumbing needs (subset of ProjectRow). */
export interface WorktreeProject {
  readonly projectId: string;
  readonly repoUrl: string;
  readonly defaultBranch: string | null;
}
function worktreePath(agentWorkspace: string, projectId: string): string {
  return join(agentWorkspace, "projects", projectId);
}

/** Task slug pattern — the single source (the ADR addendum pins it
 * verbatim; coding/task-worktrees.ts and the promote routes reuse it).
 * Lowercase-strict: on a case-insensitive FS `p1.Foo` and `p1.foo` would
 * collide silently. */
export const TASK_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Branch of an agent's main worktree (`agent/<id>/<projectId>`) or, with
 * a slug, of a task worktree (`agent/<id>/<projectId>.<slug>`). */
export function branchName(agentId: string, projectId: string, slug?: string): string {
  return `agent/${agentId}/${projectId}${slug === undefined ? "" : `.${slug}`}`;
}

/** Ensure the shared bare mirror exists and is fresh (clone --mirror on
 *  first attach, fetch --prune afterwards). Concurrent-safe: the clone
 *  writes to `<id>.git.tmp` then renames; a stale tmp is removed first.
 *  Returns the mirror path. */
export async function ensureMirror(dataDir: string, project: WorktreeProject): Promise<string> {
  const mirror = join(dataDir, "projects", `${project.projectId}.git`);
  const tmp = `${mirror}.tmp`;
  if (existsSync(mirror)) {
    // The mirror's default refspec (+refs/*:refs/*) overwrites LOCAL heads
    // on every fetch: it deletes agent worktree branches the remote lacks
    // (--prune) and reverts fast-forwarded base branches. So refresh ONLY
    // the project's base branch, ff-only, from the remote — the base
    // advances with the remote but never regresses, and local-only
    // branches (agent worktrees) are untouchable from the fetch path.
    // NOTE: a mirror clone has no refs/remotes/origin/* namespace; the
    // remote tip is reachable as FETCH_HEAD right after this fetch.
    // C1: a changed repoUrl must repoint the mirror's remote before the
    // next fetch/push — otherwise the mirror keeps talking to the old
    // origin forever.
    const currentUrl = (
      await Bun.$`git -C ${mirror} remote get-url origin`.nothrow().quiet().text()
    ).trim();
    if (currentUrl && currentUrl !== project.repoUrl) {
      await Bun.$`git -C ${mirror} remote set-url origin -- ${project.repoUrl}`.nothrow().quiet();
    }
    if (project.defaultBranch) {
      await Bun.$`git -C ${mirror} fetch -q origin -- ${project.defaultBranch}:${project.defaultBranch}`
        .nothrow()
        .quiet();
    }
    return mirror;
  }
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  await Bun.$`git clone --mirror ${project.repoUrl} ${tmp}`.quiet();
  renameSync(tmp, mirror);
  return mirror;
}

/** Ensure the agent's worktree exists on its own branch
 *  (`agent/<agentId>/<projectId>`). Returns the worktree path, or null
 *  when the slot is occupied by a plain directory (user's own files are
 *  never clobbered). */
/** The operator's git identity, from the host's config. A worktree without one
 *  makes git fall back to `Your Name <you@example.com>`, which attributes the
 *  worker's commits to nobody — GitHub then lists no contributor for the
 *  branch (live 2026-11-23). Read once per call; absent config = null, and the
 *  worktree keeps git's default rather than inventing an identity. */
export async function resolveGitIdentity(): Promise<{ name: string; email: string } | null> {
  const name = (await Bun.$`git config --get user.name`.nothrow().quiet().text()).trim();
  const email = (await Bun.$`git config --get user.email`.nothrow().quiet().text()).trim();
  if (name === "" || email === "") return null;
  return { name, email };
}

/** Write an identity into a worktree unless it already has a real one. */
export async function applyGitIdentity(worktree: string): Promise<void> {
  const current = (
    await Bun.$`git -C ${worktree} config --get user.email`.nothrow().quiet().text()
  ).trim();
  if (current !== "" && current !== "you@example.com") return;
  const who = await resolveGitIdentity();
  if (who === null) return;
  await Bun.$`git -C ${worktree} config user.name ${who.name}`.nothrow().quiet();
  await Bun.$`git -C ${worktree} config user.email ${who.email}`.nothrow().quiet();
}

/** The run writes generated files into its working directory (`.mcp.json` at
 *  minimum). They are not the project's content, but they made every worktree
 *  permanently dirty — live 2026-11-23 a worker tried to `git stash` the
 *  operator's `.mcp.json` to get a clean commit, and a hand-back would have
 *  carried the file. Excluded locally, never committed to the project. */
async function excludeGeneratedFiles(worktree: string): Promise<void> {
  const gitDir = (
    await Bun.$`git -C ${worktree} rev-parse --git-dir`.nothrow().quiet().text()
  ).trim();
  if (gitDir === "") return;
  const root = gitDir.startsWith("/") ? gitDir : `${worktree}/${gitDir}`;
  // Per-worktree exclude (the shared info/exclude would hide the file from the
  // operator's own checkout too).
  const target = `${root}/info/exclude`;
  const current = existsSync(target) ? await Bun.file(target).text() : "";
  const missing = [".mcp.json", ".oma/"].filter(
    (line) => !current.split("\n").some((existing) => existing.trim() === line),
  );
  if (missing.length === 0) return;
  const prefix = current === "" || current.endsWith("\n") ? current : `${current}\n`;
  await Bun.write(target, `${prefix}${missing.join("\n")}\n`);
}

export async function ensureWorktree(
  mirrorPath: string,
  agentWorkspace: string,
  project: WorktreeProject,
  agentId: string,
): Promise<string | null> {
  const wt = worktreePath(agentWorkspace, project.projectId);
  const listed = await Bun.$`git -C ${mirrorPath} worktree list --porcelain`.text();
  if (listed.includes(wt)) {
    // Older worktrees predate identity/exclude handling: repair in place
    // (cheap, and idempotent).
    await applyGitIdentity(wt);
    await excludeGeneratedFiles(wt);
    return wt;
  }
  if (existsSync(wt)) return null;
  const branch = branchName(agentId, project.projectId);
  const hasBranch =
    (await Bun.$`git -C ${mirrorPath} show-ref --verify refs/heads/${branch}`.quiet().nothrow())
      .exitCode === 0;
  const target = project.defaultBranch ?? "HEAD";
  mkdirSync(join(agentWorkspace, "projects"), { recursive: true });
  if (hasBranch) {
    // Branch survived (e.g. worktree dir removed out-of-band): check it out.
    await Bun.$`git -C ${mirrorPath} worktree add ${wt} ${branch}`.quiet();
  } else {
    await Bun.$`git -C ${mirrorPath} worktree add -b ${branch} ${wt} ${target}`.quiet();
  }
  await applyGitIdentity(wt);
  await excludeGeneratedFiles(wt);
  return wt;
}

/** Detach the worktree and delete its branch. */
export async function removeWorktree(
  mirrorPath: string,
  agentWorkspace: string,
  project: WorktreeProject,
  agentId: string,
): Promise<void> {
  const wt = worktreePath(agentWorkspace, project.projectId);
  await Bun.$`git -C ${mirrorPath} worktree remove --force ${wt}`.quiet().nothrow();
  await Bun.$`git -C ${mirrorPath} branch -D ${branchName(agentId, project.projectId)}`
    .quiet()
    .nothrow();
}

/** Task worktrees (Herdr's task axis on top of ADR 0023's agent axis):
 *  `<ws>/projects/<projectId>.<slug>` on branch
 *  `agent/<agentId>/<projectId>.<slug>`, based on the project's default
 *  branch. Unlike the per-agent worktree, creating is EXPLICIT and refuses
 *  collisions — a task slug is the user's words, never auto-generated. */
export async function createTaskWorktree(
  mirrorPath: string,
  agentWorkspace: string,
  project: WorktreeProject,
  agentId: string,
  slug: string,
): Promise<string> {
  if (!TASK_SLUG_RE.test(slug)) {
    throw new ValidationError(
      `invalid worktree slug: ${slug} (lowercase letters, digits, dashes; max 40)`,
    );
  }
  const wt = `${worktreePath(agentWorkspace, project.projectId)}.${slug}`;
  const branch = branchName(agentId, project.projectId, slug);
  if (existsSync(wt)) {
    throw new ConflictError(`worktree already exists: ${wt}`);
  }
  const hasBranch =
    (await Bun.$`git -C ${mirrorPath} show-ref --verify refs/heads/${branch}`.quiet().nothrow())
      .exitCode === 0;
  if (hasBranch) {
    throw new ConflictError(`branch already exists: ${branch}`);
  }
  const target = project.defaultBranch ?? "HEAD";
  await Bun.$`git -C ${mirrorPath} worktree add -b ${branch} ${wt} ${target}`.quiet();
  return wt;
}

/** Remove a task worktree and its branch. `force` is required when that
 *  would LOSE work: uncommitted changes, or commits on the branch that are
 *  not in the base (branch -D drops them). Running TERMINALS in that path
 *  are the caller's guard, not git's. */
export async function removeTaskWorktree(
  mirrorPath: string,
  agentWorkspace: string,
  project: WorktreeProject,
  agentId: string,
  slug: string,
  opts: { force: boolean },
): Promise<void> {
  const wt = `${worktreePath(agentWorkspace, project.projectId)}.${slug}`;
  const branch = `${branchName(agentId, project.projectId)}.${slug}`;
  if (!existsSync(wt)) {
    // Nothing checked out — clean up a stale branch/registration if any.
    await Bun.$`git -C ${mirrorPath} worktree prune`.quiet().nothrow();
    await Bun.$`git -C ${mirrorPath} branch -D ${branch}`.quiet().nothrow();
    throw new NotFoundError("task worktree", wt);
  }
  if (!opts.force) {
    const dirty = (await Bun.$`git -C ${wt} status --porcelain`.quiet().nothrow().text()).trim();
    if (dirty.length > 0) {
      throw new ConflictError(`worktree has uncommitted changes: ${wt}`);
    }
    const base = project.defaultBranch ?? "HEAD";
    const unmerged = Number(
      (
        await Bun.$`git -C ${mirrorPath} rev-list --count ${base}..${branch}`
          .quiet()
          .nothrow()
          .text()
      ).trim(),
    );
    if (Number.isFinite(unmerged) && unmerged > 0) {
      throw new ConflictError(
        `branch ${branch} has ${unmerged} commit(s) not in ${base} — removing deletes them`,
      );
    }
  }
  await Bun.$`git -C ${mirrorPath} worktree remove --force ${wt}`.quiet();
  await Bun.$`git -C ${mirrorPath} branch -D ${branch}`.quiet().nothrow();
  await Bun.$`git -C ${mirrorPath} worktree prune`.quiet().nothrow();
}
