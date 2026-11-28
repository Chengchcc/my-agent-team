import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { UsageError } from "./args.js";

const VALID_WORKTREE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface WorktreeHandle {
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly reused: boolean;
}

export interface WorktreeExitSummary {
  readonly action: "removed" | "kept";
  readonly worktreePath: string;
  readonly branch: string;
  readonly commitCount: number;
  readonly dirty: boolean;
  readonly message: string;
}

function runGit(
  cwd: string,
  args: readonly string[],
): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
}

/** True when `token` is a safe worktree slug (rejects spaces, slashes, `..`, flags). */
export function isValidWorktreeName(token: string): boolean {
  return VALID_WORKTREE_NAME.test(token) && !token.includes("..");
}

function defaultWorktreeName(): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  return `wt-${stamp}-${randomBytes(2).toString("hex")}`;
}

/** Ensure `.oma/worktrees/` is listed in the repo-local `.git/info/exclude`
 *  so creating isolated worktrees never dirties the parent repo's `git status`
 *  or modifies tracked `.gitignore`. Best-effort. */
function ensureWorktreesExcluded(repoRoot: string): void {
  const common = runGit(repoRoot, ["rev-parse", "--git-common-dir"]);
  if (!common.ok || !common.stdout) return;
  const excludePath = join(resolve(repoRoot, common.stdout), "info", "exclude");
  try {
    mkdirSync(join(resolve(repoRoot, common.stdout), "info"), { recursive: true });
    const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    if (current.split(/\r?\n/).some((line) => line.trim() === ".oma/worktrees/")) return;
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    appendFileSync(excludePath, `${prefix}.oma/worktrees/\n`, "utf8");
  } catch {
    /* read-only .git/info/exclude is non-fatal */
  }
}

/** Create (or reuse) an isolated git worktree under `<repoRoot>/.oma/worktrees/<name>`
 *  on branch `oma/<name>` so concurrent `oma` runs never collide on one working tree. */
export function enterWorktree(cwd: string, explicitName?: string): WorktreeHandle {
  const top = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.stdout) {
    throw new UsageError("--worktree requires running inside a git repository");
  }
  const repoRoot = top.stdout;
  const name = explicitName ?? defaultWorktreeName();
  if (!isValidWorktreeName(name)) {
    throw new UsageError(`invalid --worktree name "${name}" (use letters, digits, ".", "_", "-")`);
  }

  ensureWorktreesExcluded(repoRoot);
  const worktreesDir = join(repoRoot, ".oma", "worktrees");
  mkdirSync(worktreesDir, { recursive: true });
  const worktreePath = join(worktreesDir, name);
  const branch = `oma/${name}`;

  if (existsSync(worktreePath)) {
    const inside = runGit(worktreePath, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout !== "true") {
      throw new Error(`worktree path already exists and is not a git worktree: ${worktreePath}`);
    }
    const head = runGit(worktreePath, ["rev-parse", "HEAD"]);
    const activeBranch = runGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return {
      repoRoot,
      worktreePath,
      branch: activeBranch.ok && activeBranch.stdout ? activeBranch.stdout : branch,
      baseSha: head.stdout,
      reused: true,
    };
  }

  const branchExists = runGit(repoRoot, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  const addRes = branchExists.ok
    ? runGit(repoRoot, ["worktree", "add", worktreePath, branch])
    : runGit(repoRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
  if (!addRes.ok) {
    throw new Error(`git worktree add failed: ${addRes.stderr || addRes.stdout}`);
  }
  const head = runGit(worktreePath, ["rev-parse", "HEAD"]);
  return {
    repoRoot,
    worktreePath,
    branch,
    baseSha: head.stdout,
    reused: false,
  };
}

/** Clean up a fresh worktree if it has zero uncommitted changes and zero new
 *  commits; otherwise keep it and return an actionable summary for the user. */
export function exitWorktree(handle: WorktreeHandle): WorktreeExitSummary {
  const status = runGit(handle.worktreePath, ["status", "--porcelain"]);
  const dirty = status.ok && status.stdout.length > 0;
  const revList = handle.baseSha
    ? runGit(handle.worktreePath, ["rev-list", "--count", `${handle.baseSha}..HEAD`])
    : { ok: false, stdout: "0", stderr: "" };
  const commitCount = revList.ok ? Number.parseInt(revList.stdout, 10) || 0 : 0;

  if (!handle.reused && !dirty && commitCount === 0) {
    const removed = runGit(handle.repoRoot, ["worktree", "remove", handle.worktreePath]);
    if (removed.ok) {
      runGit(handle.repoRoot, ["branch", "-d", handle.branch]);
      return {
        action: "removed",
        worktreePath: handle.worktreePath,
        branch: handle.branch,
        commitCount: 0,
        dirty: false,
        message: `[oma] worktree ${handle.branch} had no changes — cleaned up`,
      };
    }
  }

  const parts: string[] = [];
  if (commitCount > 0) parts.push(`${commitCount} commit(s)`);
  if (dirty) parts.push("uncommitted changes");
  if (parts.length === 0 && handle.reused) parts.push("reused");
  const detail = parts.length > 0 ? `, ${parts.join(", ")}` : "";
  return {
    action: "kept",
    worktreePath: handle.worktreePath,
    branch: handle.branch,
    commitCount,
    dirty,
    message:
      `[oma] worktree kept at ${handle.worktreePath} (branch: ${handle.branch}${detail})\n` +
      `[oma] merge: git merge ${handle.branch}  |  remove: git worktree remove ${handle.worktreePath}`,
  };
}
