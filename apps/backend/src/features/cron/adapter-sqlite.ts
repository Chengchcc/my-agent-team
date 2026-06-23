import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import type { CronJobRow } from "./domain.js";
import type { CreateCronJobRecord, CronJobPort, UpdateCronJobRecord } from "./ports.js";

const toRow = (r: typeof schema.cronJob.$inferSelect): CronJobRow => ({
  cronJobId: r.cronJobId,
  name: r.name,
  agentId: r.agentId,
  cronExpr: r.cronExpr,
  prompt: r.prompt,
  enabled: r.enabled === 1,
  timeoutMs: r.timeoutMs,
  maxRetries: r.maxRetries,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export function sqliteCronJobAdapter(db: Database): CronJobPort {
  const d = drizzle(db, { schema, casing: "snake_case" });

  return {
    createCronJob(input: CreateCronJobRecord): CronJobRow {
      d.insert(schema.cronJob)
        .values({
          cronJobId: input.cronJobId,
          name: input.name,
          agentId: input.agentId,
          cronExpr: input.cronExpr,
          prompt: input.prompt,
          enabled: input.enabled ? 1 : 0,
          timeoutMs: input.timeoutMs,
          maxRetries: input.maxRetries,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
        })
        .run();
      return toRow(
        d.select().from(schema.cronJob).where(eq(schema.cronJob.cronJobId, input.cronJobId)).get()!,
      );
    },

    getCronJob(cronJobId: string): CronJobRow | null {
      const r = d
        .select()
        .from(schema.cronJob)
        .where(eq(schema.cronJob.cronJobId, cronJobId))
        .get();
      return r ? toRow(r) : null;
    },

    listCronJobs(): CronJobRow[] {
      return d.select().from(schema.cronJob).all().map(toRow);
    },

    listEnabledCronJobs(): CronJobRow[] {
      return d.select().from(schema.cronJob).where(eq(schema.cronJob.enabled, 1)).all().map(toRow);
    },

    updateCronJob(cronJobId: string, patch: UpdateCronJobRecord): CronJobRow | null {
      const sets: Record<string, unknown> = { updatedAt: patch.updatedAt };
      if (patch.name !== undefined) sets.name = patch.name;
      if (patch.agentId !== undefined) sets.agentId = patch.agentId;
      if (patch.cronExpr !== undefined) sets.cronExpr = patch.cronExpr;
      if (patch.prompt !== undefined) sets.prompt = patch.prompt;
      if (patch.enabled !== undefined) sets.enabled = patch.enabled ? 1 : 0;
      if (patch.timeoutMs !== undefined) sets.timeoutMs = patch.timeoutMs;
      if (patch.maxRetries !== undefined) sets.maxRetries = patch.maxRetries;
      if (Object.keys(sets).length <= 1) return this.getCronJob(cronJobId);
      d.update(schema.cronJob).set(sets).where(eq(schema.cronJob.cronJobId, cronJobId)).run();
      return this.getCronJob(cronJobId);
    },

    deleteCronJob(cronJobId: string): boolean {
      const result = d
        .delete(schema.cronJob)
        .where(eq(schema.cronJob.cronJobId, cronJobId))
        .returning()
        .all();
      return result.length > 0;
    },
  };
}
