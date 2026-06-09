import type { Database } from "bun:sqlite";
import type { AgentRow, CreateAgentInput, UpdateAgentInput } from "./domain.js";
import type { AgentPort } from "./ports.js";

interface DbAgentRow {
  id: string;
  name: string;
  template: string | null;
  workspace_path: string;
  model_provider: string;
  model_name: string;
  model_base_url: string | null;
  permission_mode: string;
  max_steps: number | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

function toRow(db: {
  id: string;
  name: string;
  template: string | null;
  workspace_path: string;
  model_provider: string;
  model_name: string;
  model_base_url: string | null;
  permission_mode: string;
  max_steps: number | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}): AgentRow {
  return {
    id: db.id,
    name: db.name,
    template: db.template,
    workspacePath: db.workspace_path,
    modelProvider: db.model_provider,
    modelName: db.model_name,
    modelBaseUrl: db.model_base_url,
    permissionMode: db.permission_mode as AgentRow["permissionMode"],
    maxSteps: db.max_steps,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
    archivedAt: db.archived_at,
  };
}

export function sqliteAgentAdapter(db: Database): AgentPort {
  return {
    async create(
      input: CreateAgentInput & { id: string; workspacePath: string; now: number },
    ): Promise<AgentRow> {
      db.run(
        `INSERT INTO agents (id, name, template, workspace_path, model_provider, model_name, model_base_url, permission_mode, max_steps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.name,
          input.template ?? null,
          input.workspacePath,
          input.model.provider,
          input.model.model,
          input.model.baseURL ?? null,
          input.permissionMode ?? "ask",
          input.maxSteps ?? null,
          input.now,
          input.now,
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
      // biome-ignore lint/suspicious/noExplicitAny: SQL mixed types\
      const vals: any[] = [input.now];
      if (input.name !== undefined) {
        sets.push("name = ?");
        vals.push(input.name);
      }
      if (input.permissionMode !== undefined) {
        sets.push("permission_mode = ?");
        vals.push(input.permissionMode);
      }
      if (input.maxSteps !== undefined) {
        sets.push("max_steps = ?");
        vals.push(input.maxSteps);
      }
      vals.push(id);
      const result = db.run(
        `UPDATE agents SET ${sets.join(", ")} WHERE id = ? AND archived_at IS NULL`,
        vals,
      );
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

    // M11: Permanent hard delete — all in single backend.db transaction.
    // Enable foreign_keys for CASCADE, then restore original value to avoid side effects.
    async hardDelete(
      id: string,
    ): Promise<{ deletedAgent: boolean; deletedThreads: number; deletedMembers: number }> {
      const prevFK = (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number })
        .foreign_keys;
      db.exec("PRAGMA foreign_keys = ON");

      const delAgent = db.transaction(() => {
        // Collect thread IDs for checkpoint cleanup (no FK on checkpoint tables)
        const threadRows = db.query("SELECT id FROM threads WHERE agent_id = ?").all(id) as {
          id: string;
        }[];
        const threadIds = threadRows.map((r) => r.id);

        // Delete checkpoint rows by thread ID
        let deletedThreads = threadIds.length;
        for (const tid of threadIds) {
          db.run("DELETE FROM checkpoint_messages WHERE thread_id = ?", [tid]);
          db.run("DELETE FROM checkpoint_interrupts WHERE thread_id = ?", [tid]);
          db.run("DELETE FROM checkpoint_events WHERE thread_id = ?", [tid]);
        }

        // Delete threads (CASCADE drops related rows if FK enabled)
        db.run("DELETE FROM threads WHERE agent_id = ?", [id]);

        // Delete member rows (no FK, must be explicit; ledger messages preserved)
        const memberResult = db.run("DELETE FROM member WHERE agent_id = ?", [id]);
        const deletedMembers = memberResult.changes;

        // Delete the agent row
        const agentResult = db.run("DELETE FROM agents WHERE id = ?", [id]);
        const deletedAgent = agentResult.changes > 0;

        return { deletedAgent, deletedThreads, deletedMembers };
      });

      const result = delAgent();

      // Restore previous foreign_keys setting (avoid side effect on shared connection)
      if (!prevFK) db.exec("PRAGMA foreign_keys = OFF");

      return result;
    },
  };
}
