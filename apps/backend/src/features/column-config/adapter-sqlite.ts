import type { Database } from "bun:sqlite";
import type { IssueStatus } from "../issue/entities.js";
import type { ColumnConfigRow } from "./domain.js";
import type { ColumnConfigPort, CreateColumnConfigRecord } from "./ports.js";

type Raw = {
  config_id: string;
  project_id: string;
  status: IssueStatus;
  agent_id: string;
  prompt_template: string;
  created_at: number;
  updated_at: number;
};

const toRow = (r: Raw): ColumnConfigRow => ({
  configId: r.config_id,
  projectId: r.project_id,
  status: r.status,
  agentId: r.agent_id,
  promptTemplate: r.prompt_template,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function sqliteColumnConfigAdapter(db: Database): ColumnConfigPort {
  return {
    listByProject(projectId: string): ColumnConfigRow[] {
      const rows = db
        .query(
          `SELECT * FROM column_config WHERE project_id = ?
           ORDER BY
             CASE status
               WHEN 'planned' THEN 0
               WHEN 'in_progress' THEN 1
               WHEN 'in_review' THEN 2
               WHEN 'done' THEN 3
               ELSE 4
             END`,
        )
        .all(projectId) as Raw[];
      return rows.map(toRow);
    },

    getByProjectStatus(projectId: string, status: IssueStatus): ColumnConfigRow | null {
      const r = db
        .query("SELECT * FROM column_config WHERE project_id = ? AND status = ?")
        .get(projectId, status) as Raw | undefined;
      return r ? toRow(r) : null;
    },

    upsert(input: CreateColumnConfigRecord): ColumnConfigRow {
      db.run(
        `INSERT INTO column_config (config_id, project_id, status, agent_id, prompt_template, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, status)
         DO UPDATE SET agent_id = excluded.agent_id, prompt_template = excluded.prompt_template, updated_at = excluded.updated_at`,
        [
          input.configId,
          input.projectId,
          input.status,
          input.agentId,
          input.promptTemplate,
          input.now,
          input.now,
        ],
      );
      return {
        configId: input.configId,
        projectId: input.projectId,
        status: input.status,
        agentId: input.agentId,
        promptTemplate: input.promptTemplate,
        createdAt: input.now,
        updatedAt: input.now,
      };
    },

    delete(configId: string): boolean {
      const { changes } = db.run("DELETE FROM column_config WHERE config_id = ?", [configId]);
      return changes > 0;
    },
  };
}
