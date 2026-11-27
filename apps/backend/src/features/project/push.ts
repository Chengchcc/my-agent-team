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
  /** Optional host allowlist permitted to receive `token` over HTTPS.
   *  Defaults to github.com / gitlab.com / bitbucket.org. */
  allowedHosts?: readonly string[];
  /** For the compare URL; defaults to the project's branch or "master". */
  defaultBranch?: string;
  /** Who produced the change (an agent's display name). It goes into the
   *  commit body: the author is the operator (so the commit is attributable),
   *  and the body is where the run that did the work belongs. */
  agent?: string;
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

/** Default hosts permitted to receive PROJECT_PUSH_TOKEN over HTTPS. */
const DEFAULT_PUSH_TOKEN_HOSTS = ["github.com", "gitlab.com", "bitbucket.org"] as const;

/** Build git push args for `repoUrl`: HTTPS remotes send the bearer via
 *  `http.extraHeader` (never embedded in the URL) and only to allowlisted hosts. */
function buildPushArgs(
  repoUrl: string,
  token: string | undefined,
  branch: string,
  allowedHosts?: readonly string[],
): { args: string[]; secrets: string[] } {
  if (!repoUrl.startsWith("https://")) {
    return { args: ["push", "--", repoUrl, `HEAD:refs/heads/${branch}`], secrets: [] };
  }
  if (token === undefined || token === "") {
    throw new ProjectPushRefused(
      "no push credential is configured (PROJECT_PUSH_TOKEN); ask the human to add one instead of pushing blind",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    throw new ProjectPushRefused(`invalid https repoUrl: ${repoUrl}`);
  }
  const host = parsed.hostname.toLowerCase();
  const allowed =
    allowedHosts && allowedHosts.length > 0
      ? allowedHosts.map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0)
      : DEFAULT_PUSH_TOKEN_HOSTS;
  if (!allowed.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new ProjectPushRefused(
      `refusing to send PROJECT_PUSH_TOKEN to non-allowlisted host "${host}" (allowed: ${allowed.join(", ")})`,
    );
  }
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return {
    args: [
      "-c",
      `http.extraHeader=AUTHORIZATION: Basic ${basic}`,
      "push",
      "--",
      repoUrl,
      `HEAD:refs/heads/${branch}`,
    ],
    secrets: [token, encodeURIComponent(token), basic],
  };
}

function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length > 0) out = out.replaceAll(s, "***");
  }
  return out;
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
  const dirty = status.out.trim() !== "";

  const branch = `agent/${input.runId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60)}`;
  if (branch === "agent/master" || branch === "agent/main") {
    // Cannot happen with a run id, but the guard is the contract, not the luck.
    throw new ProjectPushRefused("refusing to push to a default branch");
  }

  const checkout = git(worktree, ["checkout", "-B", branch]);
  if (checkout.code !== 0) {
    throw new ProjectPushRefused(`git checkout failed: ${checkout.err.trim().slice(0, 200)}`);
  }
  if (dirty) {
    const add = git(worktree, ["add", "-A"]);
    if (add.code !== 0) {
      throw new ProjectPushRefused(`git add failed: ${add.err.trim().slice(0, 200)}`);
    }
    // --no-verify: this commit is machinery. The project's hooks (biome,
    // commitlint) run against the WORKER's tree and message and fail the push
    // for reasons that belong to a human's commit, not to a hand-back
    // (live 2026-11-23: commitlint rejected the worker's message, no push).
    const commitArgs = ["commit", "--no-verify", "-m", input.message];
    if (input.note !== undefined && input.note.trim() !== "")
      commitArgs.push("-m", input.note.trim());
    if (input.agent !== undefined && input.agent.trim() !== "") {
      commitArgs.push("-m", `Agent: ${input.agent.trim()} (run ${input.runId})`);
    }
    const commit = git(worktree, commitArgs);
    if (commit.code !== 0) {
      throw new ProjectPushRefused(`git commit failed: ${commit.err.trim().slice(0, 200)}`);
    }
  }

  // A clean tree is NOT "nothing to push": the worker may have committed
  // already (live 2026-11-23 it did, and the old check refused a branch that
  // had one commit waiting). The decision is "are there commits no remote has".
  // Counted against the PROJECT's base branch, explicitly. `--not --remotes`
  // read 9 commits on a one-commit hand-back: the worktree's repo is a mirror
  // whose remote-tracking refs do not describe the base (live 2026-11-23).
  const base = `refs/heads/${input.defaultBranch ?? "master"}`;
  const baseExists =
    git(worktree, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).code === 0;
  const ahead = git(
    worktree,
    baseExists
      ? ["rev-list", "--count", "HEAD", "--not", base]
      : ["rev-list", "--count", "HEAD", "--not", "--remotes"],
  );
  if (ahead.code !== 0) {
    throw new ProjectPushRefused(`git rev-list failed: ${ahead.err.trim().slice(0, 200)}`);
  }
  const commits = Number.parseInt(ahead.out.trim(), 10);
  if (!Number.isFinite(commits) || commits === 0) {
    throw new ProjectPushRefused("nothing to push: no commits ahead of the remote");
  }

  const { args: pushArgs, secrets } = buildPushArgs(
    input.repoUrl,
    input.token,
    branch,
    input.allowedHosts,
  );
  const push = git(worktree, pushArgs);
  if (push.code !== 0) {
    const said = `${push.out}${push.err}`.trim();
    throw new ProjectPushRefused(`git push failed: ${redactSecrets(said, secrets).slice(0, 300)}`);
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
  return { branch, commits, compareUrl };
}
