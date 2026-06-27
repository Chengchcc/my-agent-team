import type { Database } from "bun:sqlite";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "../../infra/db/events-schema.js";

/**
 * Run drizzle-kit migrations on events.db.
 * Replaces the hand-rolled EVENTS_DB_MIGRATIONS array + _migrations ledger.
 */
export function runEventsDbMigrations(db: Database): void {
  const drizzleDb = drizzle(db, { schema, casing: "snake_case" });
  const migrationsFolder = path.resolve(import.meta.dirname, "../../../drizzle/events");
  migrate(drizzleDb, { migrationsFolder });
}
