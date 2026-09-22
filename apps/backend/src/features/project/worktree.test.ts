import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTaskWorktree,
  ensureMirror,
  ensureWorktree,
  removeTaskWorktree,
  removeWorktree,
} from "./worktree.js";

/** Build a real source repo with one commit on main. */
async function makeSourceRepo(dir: string): Promise<string> {
  const src = join(dir, "src-repo");
  mkdirSync(src, { recursive: true });
  await Bun.$`git init -b main ${src}`.quiet();
  await Bun.$`git -C ${src} config user.email t@t`.quiet();
  await Bun.$`git -C ${src} config user.name t`.quiet();
  await Bun.$`echo hello > ${join(src, "README.md")}`.quiet();
  await Bun.$`git -C ${src} add -A`.quiet();
  await Bun.$`git -C ${src} commit -m init`.quiet();
  return src;
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const PROJECT = { projectId: "p1", repoUrl: "", defaultBranch: "main" };

describe("project worktree", () => {
  test("mirror + worktree materialize idempotently; detach cleans up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-"));
    dirs.push(dir);
    const src = await makeSourceRepo(dir);
    const dataDir = join(dir, "data");
    const agentWs = join(dir, "agent-ws");
    mkdirSync(agentWs, { recursive: true });

    const mirror = await ensureMirror(dataDir, { ...PROJECT, repoUrl: src });
    expect(existsSync(join(mirror, "HEAD"))).toBe(true);
    // Second run is a fetch, not a re-clone; still fine.
    await ensureMirror(dataDir, { ...PROJECT, repoUrl: src });

    const wt = await ensureWorktree(mirror, agentWs, { ...PROJECT, repoUrl: src }, "agent-1");
    expect(wt).not.toBeNull();
    expect(existsSync(join(wt!, "README.md"))).toBe(true);
    const branch = await Bun.$`git -C ${wt} rev-parse --abbrev-ref HEAD`.text();
    expect(branch.trim()).toBe("agent/agent-1/p1");
    // Idempotent: same path, no error.
    const wt2 = await ensureWorktree(mirror, agentWs, { ...PROJECT, repoUrl: src }, "agent-1");
    expect(wt2).toBe(wt);

    await removeWorktree(mirror, agentWs, { ...PROJECT, repoUrl: src }, "agent-1");
    expect(existsSync(wt!)).toBe(false);
  });

  test("occupied worktree slot returns null (user dir never clobbered)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt2-"));
    dirs.push(dir);
    const src = await makeSourceRepo(dir);
    const agentWs = join(dir, "agent-ws");
    const slot = join(agentWs, "projects", "p1");
    mkdirSync(slot, { recursive: true });
    await Bun.$`echo mine > ${join(slot, "KEEP")}`.quiet();

    const mirror = await ensureMirror(join(dir, "data"), { ...PROJECT, repoUrl: src });
    const wt = await ensureWorktree(mirror, agentWs, { ...PROJECT, repoUrl: src }, "agent-1");
    expect(wt).toBeNull();
    expect(await Bun.$`cat ${join(slot, "KEEP")}`.text()).toContain("mine");
  });
});

describe("mirror freshness (regression: fetch used to be a no-op)", () => {
  test("ensureMirror advances the base branch when origin moves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-fresh-"));
    dirs.push(dir);
    const src = await makeSourceRepo(dir);
    const dataDir = join(dir, "data");

    const mirror = await ensureMirror(dataDir, { ...PROJECT, repoUrl: src });
    const before = await Bun.$`git -C ${mirror} rev-parse main`.quiet().text();

    // Remote advances.
    await Bun.$`echo more > ${join(src, "MORE.txt")}`.quiet();
    await Bun.$`git -C ${src} add -A`.quiet();
    await Bun.$`git -C ${src} -c user.email=t@t -c user.name=t commit -m more`.quiet();

    await ensureMirror(dataDir, { ...PROJECT, repoUrl: src });
    const after = await Bun.$`git -C ${mirror} rev-parse main`.quiet().text();
    expect(after.trim()).not.toBe(before.trim());
  });

  test("agent branches survive the base refresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-keep-"));
    dirs.push(dir);
    const src = await makeSourceRepo(dir);
    const dataDir = join(dir, "data");
    const agentWs = join(dir, "agent-ws");
    mkdirSync(agentWs, { recursive: true });

    const mirror = await ensureMirror(dataDir, { ...PROJECT, repoUrl: src });
    const wt = await ensureWorktree(mirror, agentWs, { ...PROJECT, repoUrl: src }, "agent-1");
    await Bun.$`echo w > ${join(wt!, "W")}`.quiet();
    await Bun.$`git -C ${wt} add -A`.quiet();
    await Bun.$`git -C ${wt} -c user.email=t@t -c user.name=t commit -qm w`.quiet();

    await Bun.$`echo more > ${join(src, "MORE")}`.quiet();
    await Bun.$`git -C ${src} add -A`.quiet();
    await Bun.$`git -C ${src} -c user.email=t@t -c user.name=t commit -qm m`.quiet();
    await ensureMirror(dataDir, { ...PROJECT, repoUrl: src });

    const has =
      (
        await Bun.$`git -C ${mirror} show-ref --verify refs/heads/agent/agent-1/p1`
          .nothrow()
          .quiet()
      ).exitCode === 0;
    expect(has).toBe(true);
  });
});

describe("task worktrees (Herdr task axis on the ADR 0023 layout)", () => {
  test("create checks out a slug dir on its own branch; collisions refuse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskwt-"));
    dirs.push(dir);
    const src = await makeSourceRepo(dir);
    const dataDir = join(dir, "data");
    const agentWs = join(dir, "agent-ws");
    mkdirSync(agentWs, { recursive: true });
    const project = { ...PROJECT, repoUrl: src };

    const mirror = await ensureMirror(dataDir, project);
    const path = await createTaskWorktree(mirror, agentWs, project, "agent-1", "feat-x");
    expect(path.endsWith("p1.feat-x")).toBe(true);
    expect(existsSync(join(path, "README.md"))).toBe(true);
    const branch = await Bun.$`git -C ${path} rev-parse --abbrev-ref HEAD`.text();
    expect(branch.trim()).toBe("agent/agent-1/p1.feat-x");

    // Same slug again: dir exists → refuse; bogus slug → refuse.
    await expect(createTaskWorktree(mirror, agentWs, project, "agent-1", "feat-x")).rejects.toThrow(
      /already exists/,
    );
    await expect(
      createTaskWorktree(mirror, agentWs, project, "agent-1", "no spaces!"),
    ).rejects.toThrow(/invalid worktree slug/);

    // A second slug coexists beside the first.
    const second = await createTaskWorktree(mirror, agentWs, project, "agent-1", "feat-y");
    expect(existsSync(second)).toBe(true);
  });
});

describe("task worktree removal", () => {
  test("removes dir + branch; dirty worktrees need force; missing is NotFound", async () => {
    const dir = mkdtempSync(join(tmpdir(), "taskrm-"));
    dirs.push(dir);
    const src = await makeSourceRepo(dir);
    const dataDir = join(dir, "data");
    const agentWs = join(dir, "agent-ws");
    mkdirSync(agentWs, { recursive: true });
    const project = { ...PROJECT, repoUrl: src };
    const mirror = await ensureMirror(dataDir, project);
    const path = await createTaskWorktree(mirror, agentWs, project, "agent-1", "gone");

    // Uncommitted change → refuse without force (git's own UX).
    await Bun.$`echo dirty > ${join(path, "WIP.txt")}`.quiet();
    await expect(
      removeTaskWorktree(mirror, agentWs, project, "agent-1", "gone", { force: false }),
    ).rejects.toThrow(/uncommitted changes/);

    // Force discards it, drops the branch, and prunes the registration.
    await removeTaskWorktree(mirror, agentWs, project, "agent-1", "gone", { force: true });
    expect(existsSync(path)).toBe(false);
    const branchGone =
      (
        await Bun.$`git -C ${mirror} show-ref --verify refs/heads/agent/agent-1/p1.gone`
          .nothrow()
          .quiet()
      ).exitCode !== 0;
    expect(branchGone).toBe(true);
    const listing = await Bun.$`git -C ${mirror} worktree list --porcelain`.text();
    expect(listing).not.toContain("p1.gone");

    // Second removal: already gone → NotFound.
    await expect(
      removeTaskWorktree(mirror, agentWs, project, "agent-1", "gone", { force: true }),
    ).rejects.toThrow(/not found/);
  });
});
