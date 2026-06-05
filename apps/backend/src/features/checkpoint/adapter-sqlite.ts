import type { Database } from "bun:sqlite";
import type { CheckpointReadPort } from "./ports.js";

export function sqliteCheckpointReadAdapter(db: Database): CheckpointReadPort {
  return {
    async getMessages(threadId: string): Promise<unknown[] | null> {
      const row = db
        .query("SELECT messages FROM checkpoint_messages WHERE thread_id = ?")
        .get(threadId) as { messages: string } | undefined;
      if (!row) return null;
      return JSON.parse(row.messages);
    },
  };
}
