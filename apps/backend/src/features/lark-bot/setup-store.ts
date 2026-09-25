import type { Database } from "bun:sqlite";
import { and, desc, eq, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import type { LarkProfileSetupSession } from "./setup-manager.js";

/** Where setup sessions live. A port so the manager can be driven by the real
 *  table in production and by the same table (a temp file) in tests, instead
 *  of the in-memory Map that lost every session on restart and deleted
 *  expired ones before anything could report them. */
export interface LarkSetupStore {
  insert(session: LarkProfileSetupSession): void;
  update(setupId: string, patch: Partial<LarkProfileSetupSession>): void;
  get(setupId: string): LarkProfileSetupSession | null;
  /** Newest first: a session replaced by a newer attempt must not win. */
  latestForAgent(agentId: string): LarkProfileSetupSession | null;
  /** pending && past its deadline -> expired (the row survives). */
  expireStale(now: number): void;
  /** Rows left pending by a previous process: their lark-cli child died with
   *  it, so the only honest status is expired. */
  expireAllPending(): void;
  purgeBefore(cutoff: number): void;
}

type Row = typeof schema.larkSetupSession.$inferSelect;

function toSession(row: Row): LarkProfileSetupSession {
  return {
    setupId: row.setupId,
    agentId: row.agentId,
    profileRef: row.profileRef,
    botDisplayName: row.botDisplayName,
    brand: row.brand === "lark" ? "lark" : "feishu",
    status: row.status as LarkProfileSetupSession["status"],
    url: row.url,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
  };
}

export function createLarkSetupStore(db: Database): LarkSetupStore {
  const d = drizzle(db, { schema, casing: "snake_case" });
  return {
    insert(session) {
      d.insert(schema.larkSetupSession)
        .values({
          setupId: session.setupId,
          agentId: session.agentId,
          profileRef: session.profileRef,
          botDisplayName: session.botDisplayName,
          brand: session.brand,
          status: session.status,
          url: session.url,
          error: session.error,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          expiresAt: session.expiresAt,
        })
        .run();
    },
    update(setupId, patch) {
      const { setupId: _ignored, ...rest } = patch;
      if (Object.keys(rest).length === 0) return;
      d.update(schema.larkSetupSession)
        .set({ ...rest, updatedAt: patch.updatedAt ?? Date.now() })
        .where(eq(schema.larkSetupSession.setupId, setupId))
        .run();
    },
    get(setupId) {
      const row = d
        .select()
        .from(schema.larkSetupSession)
        .where(eq(schema.larkSetupSession.setupId, setupId))
        .get();
      return row ? toSession(row) : null;
    },
    latestForAgent(agentId) {
      const row = d
        .select()
        .from(schema.larkSetupSession)
        .where(eq(schema.larkSetupSession.agentId, agentId))
        .orderBy(desc(schema.larkSetupSession.createdAt))
        .get();
      return row ? toSession(row) : null;
    },
    expireStale(now) {
      d.update(schema.larkSetupSession)
        .set({ status: "expired", updatedAt: now })
        .where(
          and(
            eq(schema.larkSetupSession.status, "pending"),
            lt(schema.larkSetupSession.expiresAt, now),
          ),
        )
        .run();
    },
    expireAllPending() {
      d.update(schema.larkSetupSession)
        .set({ status: "expired", updatedAt: Date.now() })
        .where(eq(schema.larkSetupSession.status, "pending"))
        .run();
    },
    purgeBefore(cutoff) {
      d.delete(schema.larkSetupSession).where(lt(schema.larkSetupSession.updatedAt, cutoff)).run();
    },
  };
}
