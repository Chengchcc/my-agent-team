import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRequirementWorktree } from "./requirement-workspace.js";
import { ensureMirror, excludeGeneratedFiles } from "./worktree.js";

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

describe("project mirror & generated excludes", () => {
  test("ensureMirror clones idempotently and advances base branch on remote push", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-fresh-"));
    dirs.push(dir);
    const src = await makeSourceRepo(dir);
    const dataDir = join(dir, "data");

    const mirror = await ensureMirror(dataDir, { ...PROJECT, repoUrl: src });
    expect(existsSync(join(mirror, "HEAD"))).toBe(true);
    const before = await Bun.$`git -C ${mirror} rev-parse main`.quiet().text();

    await Bun.$`echo more > ${join(src, "MORE.txt")}`.quiet();
    await Bun.$`git -C ${src} add -A`.quiet();
    await Bun.$`git -C ${src} -c user.email=t@t -c user.name=t commit -m more`.quiet();

    await ensureMirror(dataDir, { ...PROJECT, repoUrl: src });
    const after = await Bun.$`git -C ${mirror} rev-parse main`.quiet().text();
    expect(after.trim()).not.toBe(before.trim());
  });

  test("requirement branches survive mirror base refresh and exclude .mcp.json/.oma/", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-keep-"));
    dirs.push(dir);
    const src = await makeSourceRepo(dir);
    const dataDir = join(dir, "data");

    const mirror = await ensureMirror(dataDir, { ...PROJECT, repoUrl: src });
    const wt = await ensureRequirementWorktree({
      mirrorPath: mirror,
      workspacesRoot: join(dataDir, "workspaces"),
      requirementId: "req-1",
      projectId: PROJECT.projectId,
      defaultBranch: PROJECT.defaultBranch,
    });
    expect(wt).not.toBeNull();
    await excludeGeneratedFiles(wt!.path);
    await Bun.write(join(wt!.path, ".mcp.json"), "{}");
    const status = (await Bun.$`git -C ${wt!.path} status --porcelain`.text()).trim();
    expect(status).toBe("");

    await ensureMirror(dataDir, { ...PROJECT, repoUrl: src });
    const check = await Bun.$`git -C ${mirror} show-ref --verify refs/heads/${wt!.branch}`
      .quiet()
      .nothrow();
    expect(check.exitCode).toBe(0);
  });
});
