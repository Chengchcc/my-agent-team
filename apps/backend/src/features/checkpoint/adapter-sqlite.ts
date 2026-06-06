import type { Database } from "bun:sqlite";
import type { CheckpointReadPort, CheckpointWritePort } from "./ports.js";

export function sqliteCheckpointReadAdapter(db: Database): CheckpointReadPort {
  return {
    async getMessages(threadId: string): Promise<unknown[] | null> {
      const row = db
        .query("SELECT messages FROM checkpoint_messages WHERE thread_id = ?")
        .get(threadId) as { messages: string } | undefined;
      if (!row) return null;
      try {
        return JSON.parse(row.messages);
      } catch {
        return null;
      }
    },
  };
}

/** M10: Write adapter for broadcast projection — load→merge→save. */
export function sqliteCheckpointWriteAdapter(db: Database): CheckpointWritePort {
  return {
    async appendMessages(threadId: string, msgs: unknown[]): Promise<void> {
      // Load existing messages
      const row = db
        .query("SELECT messages FROM checkpoint_messages WHERE thread_id = ?")
        .get(threadId) as { messages: string } | undefined;
      const existing: unknown[] = row ? (() => {
        try { return JSON.parse(row.messages) as unknown[]; } catch { return []; }
      })() : [];

      // Merge and save
      const merged = [...existing, ...msgs];
      db.run(
        "INSERT INTO checkpoint_messages (thread_id, messages, updated_at) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at",
        [threadId, JSON.stringify(merged), Date.now()],
      );
    },
  };
}
