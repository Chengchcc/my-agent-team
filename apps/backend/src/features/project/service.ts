import type { ProjectRow } from "./domain.js";
import type { ProjectPort } from "./ports.js";

export class ProjectNotFoundError extends Error {
  constructor(id: string) {
    super(`Project not found: ${id}`);
    this.name = "ProjectNotFoundError";
  }
}

export class ValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ValidationError";
  }
}

export class ProjectInUseError extends Error {
  constructor(id: string, issueCount: number) {
    super(`Project ${id} still has ${issueCount} issue(s)`);
    this.name = "ProjectInUseError";
  }
}

export interface ProjectServiceDeps {
  port: ProjectPort;
  idGen: () => string;
  now?: () => number;
}

export function createProjectService(deps: ProjectServiceDeps) {
  const { port, idGen } = deps;
  const now = deps.now ?? Date.now;

  return {
    port,

    createProject(input: {
      name: string;
      repoUrl?: string | null;
      defaultBranch?: string | null;
      autoOrchestrate?: boolean;
    }): ProjectRow {
      const name = input.name.trim();
      if (!name) throw new ValidationError("project name required");
      try {
        return port.createProject({
          projectId: idGen(),
          name,
          repoUrl: input.repoUrl ?? null,
          defaultBranch: input.defaultBranch ?? null,
          autoOrchestrate: input.autoOrchestrate,
          createdAt: now(),
        });
      } catch (err) {
        // SQLite unique constraint on name → friendly 400
        if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
          throw new ValidationError("project name already exists");
        }
        throw err;
      }
    },

    getById(id: string): ProjectRow {
      const p = port.getProject(id);
      if (!p) throw new ProjectNotFoundError(id);
      return p;
    },

    list(): ProjectRow[] {
      return port.listProjects();
    },

    exists(id: string): boolean {
      return port.getProject(id) !== null;
    },

    update(
      id: string,
      patch: {
        name?: string;
        repoUrl?: string | null;
        defaultBranch?: string | null;
        autoOrchestrate?: boolean;
      },
    ): ProjectRow {
      if (patch.name !== undefined && !patch.name.trim()) {
        throw new ValidationError("project name must not be empty");
      }
      try {
        const p = port.updateProject(id, {
          name: patch.name?.trim() || undefined,
          repoUrl: patch.repoUrl,
          defaultBranch: patch.defaultBranch,
          autoOrchestrate: patch.autoOrchestrate,
          updatedAt: now(),
        });
        if (!p) throw new ProjectNotFoundError(id);
        return p;
      } catch (err) {
        // SQLite unique constraint on name → friendly 400
        if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
          throw new ValidationError("project name already exists");
        }
        throw err;
      }
    },

    remove(id: string): void {
      const n = port.countIssuesByProject(id);
      if (n > 0) throw new ProjectInUseError(id, n);
      if (!port.deleteProject(id)) throw new ProjectNotFoundError(id);
    },
  };
}

export type ProjectService = ReturnType<typeof createProjectService>;
