import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotFoundError } from "../../infra/domain-errors.js";
import type { ProjectRow } from "./domain.js";
import type { ProjectPort } from "./ports.js";
import { ensureRequirementWorktree } from "./requirement-workspace.js";
import { ensureMirror } from "./worktree.js";
import { createWorktreeOps } from "./worktree-ops.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function makeSource(dir: string): Promise<string> {
  const src = join(dir, "src");
  mkdirSync(src, { recursive: true });
  await Bun.$`git init -b main ${src}`.quiet();
  await Bun.$`git -C ${src} config user.email t@t`.quiet();
  await Bun.$`git -C ${src} config user.name t`.quiet();
  await Bun.$`echo base > ${join(src, "F.txt")}`.quiet();
  await Bun.$`git -C ${src} add -A`.quiet();
  await Bun.$`git -C ${src} commit -m base`.quiet();
  return src;
}

const PID = "pp";

function fakeProjectPort(repoUrl: string): ProjectPort {
  const row: ProjectRow = {
    projectId: PID,
    name: "p",
    repoUrl,
    defaultBranch: "main",
    createdAt: 0,
    updatedAt: 0,
  };
  return {
    createProject: () => {
      throw new Error("unused");
    },
    getProject: (id: string) => (id === PID ? row : null),
    listProjects: () => [],
    updateProject: () => null,
    deleteProject: () => false,
  };
}

describe("worktree ops (ADR 0077 read-only requirement workspaces)", () => {
  test("status counts ahead/behind and diff shows branch changes; unknown workspace throws 404", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wops-"));
    dirs.push(dir);
    const src = await makeSource(dir);
    const dataDir = join(dir, "data");
    const mirror = await ensureMirror(dataDir, {
      projectId: PID,
      repoUrl: src,
      defaultBranch: "main",
    });
    const reqWt = await ensureRequirementWorktree({
      mirrorPath: mirror,
      workspacesRoot: join(dataDir, "workspaces"),
      requirementId: "req-1",
      projectId: PID,
      defaultBranch: "main",
    });
    expect(reqWt).not.toBeNull();
    await Bun.$`echo work > ${join(reqWt!.path, "W.txt")}`.quiet();
    await Bun.$`git -C ${reqWt!.path} add -A`.quiet();
    await Bun.$`git -C ${reqWt!.path} -c user.email=t@t -c user.name=t commit -q -m w`.quiet();

    const ops = createWorktreeOps({
      dataDir,
      projectPort: fakeProjectPort(src),
      listWorkspacesForProject: (projectId) =>
        projectId === PID
          ? [
              {
                workspaceId: "ws-1",
                requirementId: "req-1",
                branch: reqWt!.branch,
                baseRef: reqWt!.baseRef,
                path: reqWt!.path,
              },
            ]
          : [],
    });

    const st = await ops.status(PID);
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({
      workspaceId: "ws-1",
      requirementId: "req-1",
      branch: reqWt!.branch,
      ahead: 1,
      behind: 0,
      worktreeReady: true,
    });

    const diff = await ops.diff(PID, "ws-1");
    expect(diff).toContain("W.txt");

    await expect(ops.diff(PID, "ws-missing")).rejects.toBeInstanceOf(NotFoundError);
  });
});
