import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Project facts the mirror/worktree plumbing needs (subset of ProjectRow). */
export interface WorktreeProject {
  readonly projectId: string;
  readonly repoUrl: string;
  readonly defaultBranch: string | null;
}

/** Ensure the shared bare mirror exists and is fresh (clone --mirror on
 *  first use, ff-only fetch of defaultBranch afterwards). Concurrent-safe:
 *  the clone writes to `<id>.git.tmp` then renames; a stale tmp is removed
 *  first. Returns the mirror path. */
export async function ensureMirror(dataDir: string, project: WorktreeProject): Promise<string> {
  const mirror = join(dataDir, "projects", `${project.projectId}.git`);
  const tmp = `${mirror}.tmp`;
  if (existsSync(mirror)) {
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

/** The operator's git identity, from the host's config. Absent config = null,
 *  and the checkout keeps git's default rather than inventing an identity. */
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

/** Exclude generated runtime files (`.mcp.json`, `.oma/`) in the common
 *  git dir's `info/exclude` so checkouts stay clean without modifying tracked
 *  `.gitignore`. */
export async function excludeGeneratedFiles(worktree: string): Promise<void> {
  const gitDir = (
    await Bun.$`git -C ${worktree} rev-parse --git-path info/exclude`.nothrow().quiet().text()
  ).trim();
  if (gitDir === "") return;
  const target = gitDir.startsWith("/") ? gitDir : `${worktree}/${gitDir}`;
  const current = existsSync(target) ? await Bun.file(target).text() : "";
  const missing = [".mcp.json", ".oma/"].filter(
    (line) => !current.split("\n").some((existing) => existing.trim() === line),
  );
  if (missing.length === 0) return;
  const prefix = current === "" || current.endsWith("\n") ? current : `${current}\n`;
  await Bun.write(target, `${prefix}${missing.join("\n")}\n`);
}
