import type { Database } from "bun:sqlite";
import type { ProjectRow } from "./domain.js";
import type { CreateProjectRecord, ProjectPort, UpdateProjectRecord } from "./ports.js";

type Raw = {
  project_id: string;
  name: string;
  repo_url: string | null;
  default_branch: string | null;
  created_at: number;
  updated_at: number;
};

const toRow = (r: Raw): ProjectRow => ({
  projectId: r.project_id,
  name: r.name,
  repoUrl: r.repo_url,
  defaultBranch: r.default_branch,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function sqliteProjectAdapter(db: Database): ProjectPort {
  return {
    createProject(input: CreateProjectRecord): ProjectRow {
      db.run(
        `INSERT INTO project (project_id, name, repo_url, default_branch, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          input.projectId,
          input.name,
          input.repoUrl,
          input.defaultBranch,
          input.createdAt,
          input.createdAt,
        ],
      );
      return {
        projectId: input.projectId,
        name: input.name,
        repoUrl: input.repoUrl,
        defaultBranch: input.defaultBranch,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
    },

    getProject(projectId: string): ProjectRow | null {
      const r = db.query("SELECT * FROM project WHERE project_id = ?").get(projectId) as
        | Raw
        | undefined;
      return r ? toRow(r) : null;
    },

    listProjects(): ProjectRow[] {
      const rows = db.query("SELECT * FROM project ORDER BY created_at DESC").all() as Raw[];
      return rows.map(toRow);
    },

    updateProject(projectId: string, patch: UpdateProjectRecord): ProjectRow | null {
      const sets: string[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any[] = [];

      if (patch.name !== undefined) {
        sets.push("name = ?");
        params.push(patch.name);
      }
      if (patch.repoUrl !== undefined) {
        sets.push("repo_url = ?");
        params.push(patch.repoUrl);
      }
      if (patch.defaultBranch !== undefined) {
        sets.push("default_branch = ?");
        params.push(patch.defaultBranch);
      }

      if (sets.length === 0) {
        // Nothing to update — return current row
        return this.getProject(projectId);
      }

      sets.push("updated_at = ?");
      params.push(patch.updatedAt);
      params.push(projectId);

      db.run(`UPDATE project SET ${sets.join(", ")} WHERE project_id = ?`, params);
      // 写后重读：保证返回对象等于库内真值
      return this.getProject(projectId);
    },

    deleteProject(projectId: string): boolean {
      const { changes } = db.run("DELETE FROM project WHERE project_id = ?", [projectId]);
      return changes > 0;
    },

    countIssuesByProject(projectId: string): number {
      const r = db.query("SELECT COUNT(*) AS n FROM issue WHERE project_id = ?").get(projectId) as {
        n: number;
      };
      return r.n;
    },
  };
}
