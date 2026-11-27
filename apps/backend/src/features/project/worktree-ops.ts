import { existsSync } from "node:fs";
import { NotFoundError } from "../../infra/domain-errors.js";
import type { ProjectPort } from "./ports.js";
import { ensureMirror } from "./worktree.js";

/** ADR 0077: read-only status of one requirement-owned checkout. */
export interface WorktreeStatus {
  workspaceId: string;
  requirementId: string | null;
  branch: string;
  path: string;
  ahead: number;
  behind: number;
  worktreeReady: boolean;
}

export interface ProjectWorkspaceRef {
  workspaceId: string;
  requirementId: string | null;
  branch: string;
  baseRef: string;
  path: string;
}

/** Read-only git inspection over a project's requirement workspaces (ADR 0076 /
 *  ADR 0077). Delivery goes through `project_push` to an `agent/*` branch + PR;
 *  direct mirror fast-forward / merge into the default branch is retired. */
export interface WorktreeOps {
  status(projectId: string): Promise<WorktreeStatus[]>;
  diff(projectId: string, workspaceId: string): Promise<string>;
}

export function createWorktreeOps(deps: {
  dataDir: string;
  projectPort: ProjectPort;
  listWorkspacesForProject: (projectId: string) => readonly ProjectWorkspaceRef[];
}): WorktreeOps {
  const projectOf = (projectId: string) => {
    const project = deps.projectPort.getProject(projectId);
    if (!project?.repoUrl) throw new Error(`project ${projectId} has no repoUrl`);
    return project;
  };

  const mirrorOf = async (projectId: string): Promise<string> => {
    const project = projectOf(projectId);
    return ensureMirror(deps.dataDir, {
      projectId: project.projectId,
      repoUrl: project.repoUrl as string,
      defaultBranch: project.defaultBranch,
    });
  };

  const baseRef = async (projectId: string, mirror: string): Promise<string> => {
    const named = projectOf(projectId).defaultBranch;
    if (named) return named;
    const head = await Bun.$`git -C ${mirror} symbolic-ref --short HEAD`.nothrow().quiet().text();
    return head.trim() || "main";
  };

  const counts = async (mirror: string, base: string, branch: string) => {
    const out = await Bun.$`git -C ${mirror} rev-list --left-right --count ${base}...${branch}`
      .quiet()
      .nothrow()
      .text();
    const [behind, ahead] = out.trim().split(/\s+/).map(Number);
    return { behind: behind ?? 0, ahead: ahead ?? 0 };
  };

  return {
    async status(projectId) {
      const mirror = await mirrorOf(projectId);
      const defaultBase = await baseRef(projectId, mirror);
      const workspaces = deps.listWorkspacesForProject(projectId);
      const out: WorktreeStatus[] = [];
      for (const ws of workspaces) {
        const has =
          (
            await Bun.$`git -C ${mirror} show-ref --verify refs/heads/${ws.branch}`
              .quiet()
              .nothrow()
          ).exitCode === 0;
        if (!has) continue;
        const { behind, ahead } = await counts(mirror, ws.baseRef || defaultBase, ws.branch);
        out.push({
          workspaceId: ws.workspaceId,
          requirementId: ws.requirementId,
          branch: ws.branch,
          path: ws.path,
          ahead,
          behind,
          worktreeReady: existsSync(ws.path),
        });
      }
      return out;
    },

    async diff(projectId, workspaceId) {
      const ws = deps
        .listWorkspacesForProject(projectId)
        .find((row) => row.workspaceId === workspaceId);
      if (!ws) throw new NotFoundError("workspace", workspaceId);
      const mirror = await mirrorOf(projectId);
      const base = ws.baseRef || (await baseRef(projectId, mirror));
      return Bun.$`git -C ${mirror} diff ${base}...${ws.branch}`.quiet().text();
    },
  };
}
