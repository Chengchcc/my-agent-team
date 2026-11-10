import type { Database } from "bun:sqlite";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import type { ProactiveEvent } from "./domain.js";
import type { ProactiveEventPort } from "./ports.js";

export function sqliteProactiveAdapter(db: Database): ProactiveEventPort {
  const d = drizzle(db, { schema, casing: "snake_case" });

  const rowOf = (r: typeof schema.proactiveEvent.$inferSelect): ProactiveEvent => ({
    id: r.id,
    ts: r.ts,
    agentId: r.agentId,
    conversationId: r.conversationId,
    ruleId: r.ruleId,
    mode: r.mode as ProactiveEvent["mode"],
    outcome: r.outcome as ProactiveEvent["outcome"],
    chatId: r.chatId ?? null,
    senderMemberId: r.senderMemberId ?? null,
    snippet: r.snippet,
  });

  return {
    insertEvent(event: ProactiveEvent): void {
      d.insert(schema.proactiveEvent).values(event).run();
    },
    listEvents({ agentId, limit }): ProactiveEvent[] {
      const base = d.select().from(schema.proactiveEvent);
      const rows = (agentId ? base.where(eq(schema.proactiveEvent.agentId, agentId)) : base)
        .orderBy(desc(schema.proactiveEvent.ts), desc(schema.proactiveEvent.id))
        .limit(limit)
        .all();
      return rows.map(rowOf);
    },
  };
}
