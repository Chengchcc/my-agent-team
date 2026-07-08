import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import type { SettingsRow } from "./domain.js";
import type { SettingsPort } from "./ports.js";

export function sqliteSettingsAdapter(db: Database): SettingsPort {
  const d = drizzle(db, { schema, casing: "snake_case" });

  return {
    get(key: string): SettingsRow | undefined {
      return d.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
    },

    set(key: string, value: string): void {
      const now = Date.now();
      const existing = d.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
      if (existing) {
        d.update(schema.settings)
          .set({ value, updatedAt: now })
          .where(eq(schema.settings.key, key))
          .run();
      } else {
        d.insert(schema.settings).values({ key, value, updatedAt: now }).run();
      }
    },

    getAll(): SettingsRow[] {
      return d.select().from(schema.settings).all();
    },
  };
}
