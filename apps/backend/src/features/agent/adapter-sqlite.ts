import type { Database } from "bun:sqlite";
import type { AgentPort } from "./ports.js";
import type { AgentRow, CreateAgentInput, UpdateAgentInput } from "./domain.js";

interface DbAgentRow {
  id: string; name: string; template: string | null;
  workspace_path: string; model_provider: string; model_name: string;
  model_base_url: string | null; permission_mode: string; max_steps: number | null;
  created_at: number; updated_at: number; archived_at: number | null;
}

function toRow(db: { id: string; name: string; template: string | null; workspace_path: string; model_provider: string; model_name: string; model_base_url: string | null; permission_mode: string; max_steps: number | null; created_at: number; updated_at: number; archived_at: number | null }): AgentRow {
  return {
    id: db.id, name: db.name, template: db.template,
    workspacePath: db.workspace_path,
    modelProvider: db.model_provider, modelName: db.model_name,
    modelBaseUrl: db.model_base_url,
    permissionMode: db.permission_mode as AgentRow["permissionMode"],
    maxSteps: db.max_steps, createdAt: db.created_at,
    updatedAt: db.updated_at, archivedAt: db.archived_at,
  };
}

export function sqliteAgentAdapter(db: Database): AgentPort {
  return {
    async create(input: CreateAgentInput & { id: string; workspacePath: string; now: number }): Promise<AgentRow> {
      db.run(
        `INSERT INTO agents (id, name, template, workspace_path, model_provider, model_name, model_base_url, permission_mode, max_steps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id, input.name, input.template ?? null, input.workspacePath,
          input.model.provider, input.model.model, input.model.baseURL ?? null,
          input.permissionMode ?? "ask", input.maxSteps ?? null,
          input.now, input.now,
        ],
      );
      const raw = db.query("SELECT * FROM agents WHERE id = ?").get(input.id) as DbAgentRow;
      return toRow(raw);
    },

    async findById(id: string): Promise<AgentRow | null> {
      const raw = db.query("SELECT * FROM agents WHERE id = ?").get(id) as DbAgentRow | undefined;
      return raw ? toRow(raw) : null;
    },

    async list(includeArchived = false): Promise<AgentRow[]> {
      const sql = includeArchived
        ? "SELECT * FROM agents ORDER BY created_at DESC"
        : "SELECT * FROM agents WHERE archived_at IS NULL ORDER BY created_at DESC";
      return (db.query(sql).all() as DbAgentRow[]).map(toRow);
    },

    async update(id: string, input: UpdateAgentInput & { now: number }): Promise<AgentRow | null> {
      const sets: string[] = ["updated_at = ?"];
      const vals: any[] = [input.now];
      if (input.name !== undefined) { sets.push("name = ?"); vals.push(input.name); }
      if (input.permissionMode !== undefined) { sets.push("permission_mode = ?"); vals.push(input.permissionMode); }
      if (input.maxSteps !== undefined) { sets.push("max_steps = ?"); vals.push(input.maxSteps); }
      vals.push(id);
      const result = db.run(`UPDATE agents SET ${sets.join(", ")} WHERE id = ? AND archived_at IS NULL`, vals);
      if (result.changes === 0) return null;
      const raw = db.query("SELECT * FROM agents WHERE id = ?").get(id) as DbAgentRow;
      return toRow(raw);
    },

    async archive(id: string, now: number): Promise<AgentRow | null> {
      const result = db.run(
        "UPDATE agents SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL",
        [now, now, id],
      );
      if (result.changes === 0) return null;
      const raw = db.query("SELECT * FROM agents WHERE id = ?").get(id) as DbAgentRow;
      return toRow(raw);
    },
  };
}
