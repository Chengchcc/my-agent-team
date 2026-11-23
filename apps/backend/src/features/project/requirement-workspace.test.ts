import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRequirementWorktree, requirementBranchOf } from "./requirement-workspace.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sh(cwd: string, args: readonly string[]): void {
  const res = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if ((res.exitCode ?? 1) !== 0) throw new Error(`${args.join(" ")}: ${res.stderr.toString()}`);
}

/** A bare mirror with one commit on master, as the project mirror looks. */
function mirror(): { root: string; mirrorPath: string } {
  const root = mkdtempSync(join(tmpdir(), "req-ws-"));
  dirs.push(root);
  const seed = join(root, "seed");
  mkdir(seed);
  sh(root, ["init", "-q", "-b", "master", seed]);
  sh(seed, ["config", "user.email", "t@l"]);
  sh(seed, ["config", "user.name", "t"]);
  writeFileSync(join(seed, "README.md"), "hello\n");
  sh(seed, ["add", "-A"]);
  sh(seed, ["commit", "-q", "-m", "seed"]);
  const bare = join(root, "mirror.git");
  sh(root, ["clone", "--bare", "-q", seed, bare]);
  return { root, mirrorPath: bare };
}
function mkdir(p: string): void {
  sh(tmpdir(), ["init", "-q", p]);
}

describe("a requirement owns its checkout", () => {
  test("the branch is derived from the requirement, never the default one", () => {
    expect(requirementBranchOf("R-42")).toBe("req/R-42");
    expect(requirementBranchOf("weird/id with spaces")).not.toContain(" ");
  });

  test("a workspace is a worktree at the project's base, idempotent", async () => {
    const { root, mirrorPath } = mirror();
    const workspacesRoot = join(root, "workspaces");
    const first = await ensureRequirementWorktree({
      mirrorPath,
      workspacesRoot,
      requirementId: "R-1",
      projectId: "p1",
      defaultBranch: "master",
    });
    expect(first?.branch).toBe("req/R-1");
    expect(first?.baseRef.length).toBeGreaterThan(0);
    // The worktree really is a checkout of that branch.
    const head = Bun.spawnSync(["git", "-C", first!.path, "rev-parse", "--abbrev-ref", "HEAD"], {
      stdout: "pipe",
    });
    expect(head.stdout.toString().trim()).toBe("req/R-1");
    // Idempotent: a second ensure reuses the same path.
    const again = await ensureRequirementWorktree({
      mirrorPath,
      workspacesRoot,
      requirementId: "R-1",
      projectId: "p1",
      defaultBranch: "master",
    });
    expect(again?.path).toBe(first?.path);
  });

  test("two requirements get two checkouts, so neither sees the other's work", async () => {
    const { root, mirrorPath } = mirror();
    const workspacesRoot = join(root, "workspaces");
    const a = await ensureRequirementWorktree({
      mirrorPath,
      workspacesRoot,
      requirementId: "R-A",
      projectId: "p1",
      defaultBranch: "master",
    });
    const b = await ensureRequirementWorktree({
      mirrorPath,
      workspacesRoot,
      requirementId: "R-B",
      projectId: "p1",
      defaultBranch: "master",
    });
    expect(a?.path).not.toBe(b?.path);
    writeFileSync(join(a!.path, "README.md"), "A changed this\n");
    const statusB = Bun.spawnSync(["git", "-C", b!.path, "status", "--short"], { stdout: "pipe" });
    expect(statusB.stdout.toString().trim()).toBe("");
  });

  test("the checkout excludes the run's generated files", async () => {
    const { root, mirrorPath } = mirror();
    const wt = await ensureRequirementWorktree({
      mirrorPath,
      workspacesRoot: join(root, "workspaces"),
      requirementId: "R-2",
      projectId: "p1",
      defaultBranch: "master",
    });
    writeFileSync(join(wt!.path, ".mcp.json"), "{}\n");
    const status = Bun.spawnSync(["git", "-C", wt!.path, "status", "--short"], { stdout: "pipe" });
    expect(status.stdout.toString().trim()).toBe("");
  });
});
