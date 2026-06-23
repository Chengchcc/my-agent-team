import type { Database } from "bun:sqlite";
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import * as schema from "../../infra/db/schema.js";
import type { AgentRow, CreateAgentInput, UpdateAgentInput } from "./domain.js";
import type { AgentPort } from "./ports.js";

const permissionModeSchema = z.enum(["ask", "auto", "deny"]);

function toRow(r: typeof schema.agents.$inferSelect): AgentRow {
  return {
    id: r.id,
    name: r.name,
    template: r.template,
    workspacePath: r.workspacePath,
    modelProvider: r.modelProvider,
    modelName: r.modelName,
    modelBaseUrl: r.modelBaseUrl,
    permissionMode: permissionModeSchema.parse(r.permissionMode),
    maxSteps: r.maxSteps,
    larkEnabled: r.larkEnabled === 1,
    larkAppId: r.larkAppId,
    larkProfileRef: r.larkProfileRef,
    larkBotDisplayName: r.larkBotDisplayName,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    archivedAt: r.archivedAt,
  };
}

export function sqliteAgentAdapter(db: Database): AgentPort {
  const d = drizzle(db, { schema });

  return {
    async create(
      input: CreateAgentInput & {
        id: string;
        workspacePath: string;
        now: number;
        larkEnabled: boolean;
        larkAppId: string | null;
        larkProfileRef: string | null;
        larkBotDisplayName: string | null;
      },
    ): Promise<AgentRow> {
      d.insert(schema.agents)
        .values({
          id: input.id,
          name: input.name,
          template: input.template ?? null,
          workspacePath: input.workspacePath,
          modelProvider: input.model.provider,
          modelName: input.model.model,
          modelBaseUrl: input.model.baseURL ?? null,
          permissionMode: input.permissionMode ?? "ask",
          maxSteps: input.maxSteps ?? null,
          larkEnabled: input.larkEnabled ? 1 : 0,
          larkAppId: input.larkAppId ?? null,
          larkProfileRef: input.larkProfileRef ?? null,
          larkBotDisplayName: input.larkBotDisplayName ?? null,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .run();
      const raw = d.select().from(schema.agents).where(eq(schema.agents.id, input.id)).get();
      return toRow(raw!);
    },

    async findById(id: string): Promise<AgentRow | null> {
      const raw = d.select().from(schema.agents).where(eq(schema.agents.id, id)).get();
      return raw ? toRow(raw) : null;
    },

    async list(includeArchived = false): Promise<AgentRow[]> {
      const rows = includeArchived
        ? d.select().from(schema.agents).orderBy(desc(schema.agents.createdAt)).all()
        : d
            .select()
            .from(schema.agents)
            .where(isNull(schema.agents.archivedAt))
            .orderBy(desc(schema.agents.createdAt))
            .all();
      return rows.map(toRow);
    },

    async update(
      id: string,
      input: UpdateAgentInput & { now: number; lark?: { profileRef?: string } },
    ): Promise<AgentRow | null> {
      const sets: Partial<typeof schema.agents.$inferInsert> = { updatedAt: input.now };
      if (input.name !== undefined) sets.name = input.name;
      if (input.permissionMode !== undefined) sets.permissionMode = input.permissionMode;
      if (input.maxSteps !== undefined) sets.maxSteps = input.maxSteps;
      if (input.lark?.enabled !== undefined) sets.larkEnabled = input.lark.enabled ? 1 : 0;
      if (input.lark?.appId !== undefined) sets.larkAppId = input.lark.appId;
      if (input.lark?.botDisplayName !== undefined) {
        sets.larkBotDisplayName = input.lark.botDisplayName;
      }
      if (input.lark?.profileRef !== undefined) sets.larkProfileRef = input.lark.profileRef;

      const rows = d
        .update(schema.agents)
        .set(sets)
        .where(and(eq(schema.agents.id, id), isNull(schema.agents.archivedAt)))
        .returning()
        .all();

      if (rows.length === 0) return null;
      const raw = d.select().from(schema.agents).where(eq(schema.agents.id, id)).get();
      return raw ? toRow(raw) : null;
    },

    async archive(id: string, now: number): Promise<AgentRow | null> {
      const rows = d
        .update(schema.agents)
        .set({ archivedAt: now, updatedAt: now })
        .where(and(eq(schema.agents.id, id), isNull(schema.agents.archivedAt)))
        .returning()
        .all();
      if (rows.length === 0) return null;
      const raw = d.select().from(schema.agents).where(eq(schema.agents.id, id)).get();
      return raw ? toRow(raw) : null;
    },

    // M11: Permanent hard delete — all in single backend.db transaction.
    // Enable foreign_keys for CASCADE, then restore original value to avoid side effects.
    async hardDelete(
      id: string,
    ): Promise<{ deletedAgent: boolean; deletedThreads: number; deletedMembers: number }> {
      const prevFK = (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number })
        .foreign_keys;
      // PRAGMA foreign_keys kept as raw db.exec — drizzle has no native PRAGMA abstraction.
      db.exec("PRAGMA foreign_keys = ON");

      const delAgent = db.transaction(() => {
        // Collect derived thread IDs (cid:memberId) for projection cleanup.
        // Threads table is gone (M14) — conversation membership is the source of truth.
        // M20: Derived column kept as raw SQL — drizzle has no native || operator.
        const threadRows = db
          .query("SELECT conversation_id || ':' || member_id AS id FROM member WHERE agent_id = ?")
          .all(id) as { id: string }[];
        const threadIds = threadRows.map((r) => r.id);

        // Delete projection_messages by thread ID
        const deletedThreads = threadIds.length;
        for (const tid of threadIds) {
          db.run("DELETE FROM projection_messages WHERE thread_id = ?", [tid]);
          // M20: checkpoint_interrupts and checkpoint_events are NOT in backend.db.
          // They live in checkpointer.sqlite (independent physical database).
          // The old DELETE statements for these tables were dead code — removed.
        }

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
