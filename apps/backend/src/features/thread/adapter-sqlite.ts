import type { Database } from "bun:sqlite";
import type { ThreadPort } from "./ports.js";
import type { ThreadRow } from "./domain.js";

interface DbThreadRow {
  id: string; agent_id: string; title: string | null;
  kind: string; created_at: number; updated_at: number; last_run_at: number | null;
}

function toRow(db: DbThreadRow): ThreadRow {
  return {
    id: db.id, agentId: db.agent_id, title: db.title,
    kind: db.kind as "conversation",
    createdAt: db.created_at, updatedAt: db.updated_at, lastRunAt: db.last_run_at,
  };
}

export function sqliteThreadAdapter(db: Database): ThreadPort {
  return {
    create(input): ThreadRow {
      db.run(
        `INSERT INTO threads (id, agent_id, title, kind, created_at, updated_at)
         VALUES (?, ?, ?, 'conversation', ?, ?)`,
        [input.id, input.agentId, input.title ?? null, input.now, input.now],
      );
      return toRow(db.query("SELECT * FROM threads WHERE id = ?").get(input.id) as DbThreadRow);
    },
    findById(id): ThreadRow | null {
      const row = db.query("SELECT * FROM threads WHERE id = ?").get(id) as DbThreadRow | undefined;
      return row ? toRow(row) : null;
    },
    listByAgent(agentId): ThreadRow[] {
      return (db.query("SELECT * FROM threads WHERE agent_id = ? ORDER BY updated_at DESC").all(agentId) as DbThreadRow[]).map(toRow);
    },
    update(id, input): ThreadRow | null {
      const sets: string[] = ["updated_at = ?"]; const vals: unknown[] = [input.now];
      if (input.title !== undefined) { sets.push("title = ?"); vals.push(input.title); }
      if (input.lastRunAt !== undefined) { sets.push("last_run_at = ?"); vals.push(input.lastRunAt); }
      vals.push(id);
      const r = db.run(`UPDATE threads SET ${sets.join(", ")} WHERE id = ?`, vals);
      if (r.changes === 0) return null;
      return toRow(db.query("SELECT * FROM threads WHERE id = ?").get(id) as DbThreadRow);
    },
    delete(id): boolean {
      return db.run("DELETE FROM threads WHERE id = ?", [id]).changes > 0;
    },
  };
}
