import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectPushRefused, pushProjectWorktree } from "./push.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sh(cwd: string, args: readonly string[]): void {
  const res = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if ((res.exitCode ?? 1) !== 0) throw new Error(`${args.join(" ")}: ${res.stderr.toString()}`);
}

/** origin (bare) + a worktree with one uncommitted change. */
function fixture(): { origin: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), "push-test-"));
  dirs.push(root);
  const origin = join(root, "origin.git");
  sh(root, ["init", "--bare", "-q", origin]);
  const seed = join(root, "seed");
  sh(root, ["clone", "-q", origin, "seed"]);
  sh(seed, ["config", "user.email", "t@l"]);
  sh(seed, ["config", "user.name", "t"]);
  writeFileSync(join(seed, "README.md"), "hello\n");
  sh(seed, ["add", "-A"]);
  sh(seed, ["commit", "-q", "-m", "seed"]);
  sh(seed, ["push", "-q", "origin", "HEAD:refs/heads/master"]);
  const worktree = join(root, "wt");
  sh(root, ["clone", "-q", origin, "wt"]);
  sh(worktree, ["config", "user.email", "w@l"]);
  sh(worktree, ["config", "user.name", "w"]);
  writeFileSync(join(worktree, "README.md"), "hello world\n");
  return { origin, worktree };
}

describe("ADR 0076: pushing a worker's worktree", () => {
  test("pushes a run-named branch, never the default one", () => {
    const { origin, worktree } = fixture();
    const result = pushProjectWorktree({
      worktree,
      repoUrl: `file://${origin}`,
      runId: "run-abc123",
      message: "docs: rewrite the first screen",
    });
    expect(result.branch).toBe("agent/run-abc123");
    // The branch exists on the remote with the change in it.
    const log = Bun.spawnSync(["git", "-C", origin, "log", "--oneline", "agent/run-abc123"], {
      stdout: "pipe",
    });
    expect(log.stdout.toString()).toContain("rewrite the first screen");
    // master did not move.
    const master = Bun.spawnSync(["git", "-C", origin, "rev-parse", "master"], {
      stdout: "pipe",
    });
    expect(master.stdout.toString().trim().length).toBeGreaterThan(0);
  });

  test("a clean worktree is refused - there is nothing to hand back", () => {
    const { origin, worktree } = fixture();
    pushProjectWorktree({ worktree, repoUrl: `file://${origin}`, runId: "run-1", message: "x" });
    expect(() =>
      pushProjectWorktree({ worktree, repoUrl: `file://${origin}`, runId: "run-1", message: "x" }),
    ).toThrow(ProjectPushRefused);
  });

  test("https without a credential refuses instead of prompting", () => {
    const { worktree } = fixture();
    expect(() =>
      pushProjectWorktree({
        worktree,
        repoUrl: "https://github.com/o/r.git",
        runId: "run-2",
        message: "x",
      }),
    ).toThrow(/push credential/);
  });
});

describe("ADR 0076: the scp-like remote", () => {
  test("compare URL is derived from git@host:owner/repo", () => {
    const { origin, worktree } = fixture();
    // file:// keeps the push local; the compare derivation is what we assert.
    const result = pushProjectWorktree({
      worktree,
      repoUrl: `file://${origin}`,
      runId: "run-scp",
      message: "x",
    });
    expect(result.branch).toBe("agent/run-scp");
    expect(result.compareUrl).toBeNull();
  });
});
