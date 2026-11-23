/** ADR 0076: write a worker's worktree back to its project remote.
 *
 *  The worker never holds a credential and never names a branch: the branch is
 *  derived from the run id here, the token lives in the backend's environment,
 *  and master is unreachable by construction. A person reviews the compare URL
 *  and merges — that is the whole point of the branch name.
 */
import { existsSync } from "node:fs";

export interface ProjectPushInput {
  /** The worker's worktree (`<workspace>/projects/<projectId>`). */
  worktree: string;
  /** Where to push (project.repoUrl). */
  repoUrl: string;
  /** The run that produced the change — the branch is derived from it. */
  runId: string;
  /** Commit subject. */
  message: string;
  note?: string;
  /** Push credential. Absent = https remotes are refused (never a prompt). */
  token?: string;
  /** For the compare URL; defaults to the project's branch or "master". */
  defaultBranch?: string;
}

export interface ProjectPushResult {
  branch: string;
  commits: number;
  compareUrl: string | null;
}

export class ProjectPushRefused extends Error {}

function git(cwd: string, args: readonly string[]): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: result.exitCode ?? 1,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

/** https remotes need the token; file/ssh remotes carry their own auth. */
function pushUrl(repoUrl: string, token: string | undefined): string {
  if (!repoUrl.startsWith("https://")) return repoUrl;
  if (token === undefined || token === "") {
    throw new ProjectPushRefused(
      "no push credential is configured (PROJECT_PUSH_TOKEN); ask the human to add one instead of pushing blind",
    );
  }
  const rest = repoUrl.slice("https://".length);
  return `https://x-access-token:${encodeURIComponent(token)}@${rest}`;
}

export function pushProjectWorktree(input: ProjectPushInput): ProjectPushResult {
  const worktree = input.worktree;
  if (!existsSync(worktree)) {
    throw new ProjectPushRefused(`worktree not found: ${worktree}`);
  }
  const inside = git(worktree, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0) {
    throw new ProjectPushRefused(`${worktree} is not a git worktree`);
  }
  const status = git(worktree, ["status", "--porcelain"]);
  if (status.code !== 0) {
    throw new ProjectPushRefused(`git status failed: ${status.err.trim().slice(0, 200)}`);
  }
  if (status.out.trim() === "") {
    throw new ProjectPushRefused("nothing to push: the worktree has no changes");
  }

  const branch = `agent/${input.runId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60)}`;
  if (branch === "agent/master" || branch === "agent/main") {
    // Cannot happen with a run id, but the guard is the contract, not the luck.
    throw new ProjectPushRefused("refusing to push to a default branch");
  }

  const checkout = git(worktree, ["checkout", "-B", branch]);
  if (checkout.code !== 0) {
    throw new ProjectPushRefused(`git checkout failed: ${checkout.err.trim().slice(0, 200)}`);
  }
  const add = git(worktree, ["add", "-A"]);
  if (add.code !== 0) {
    throw new ProjectPushRefused(`git add failed: ${add.err.trim().slice(0, 200)}`);
  }
  const commitArgs = ["commit", "-m", input.message];
  if (input.note !== undefined && input.note.trim() !== "")
    commitArgs.push("-m", input.note.trim());
  const commit = git(worktree, commitArgs);
  if (commit.code !== 0) {
    throw new ProjectPushRefused(`git commit failed: ${commit.err.trim().slice(0, 200)}`);
  }

  const url = pushUrl(input.repoUrl, input.token);
  const push = git(worktree, ["push", url, `HEAD:refs/heads/${branch}`]);
  if (push.code !== 0) {
    const said = `${push.out}${push.err}`.trim();
    throw new ProjectPushRefused(
      `git push failed: ${said.replaceAll(input.token ?? "\u0000", "***").slice(0, 300)}`,
    );
  }

  // The compare URL is what the person clicks; derive it from either remote
  // shape (https or `git@host:owner/repo`).
  let compareUrl: string | null = null;
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(.+)$/.exec(input.repoUrl);
  let webBase: string | null = null;
  if (input.repoUrl.startsWith("https://")) {
    webBase = input.repoUrl.replace(/\.git$/, "").replace(/\/$/, "");
  } else if (scp !== null) {
    webBase = `https://${scp[1]}/${scp[2]!.replace(/\.git$/, "")}`;
  }
  if (webBase !== null) {
    const target = input.defaultBranch ?? "master";
    compareUrl = `${webBase}/compare/${target}...${branch}`;
  }
  return { branch, commits: 1, compareUrl };
}
