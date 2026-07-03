import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteCronJobAdapter } from "./adapter-sqlite.js";
import type { CronJobPort } from "./ports.js";

const dbPath = `/tmp/test-cron-adapter-${Date.now()}-${randomUUID()}.db`;
const db: Database = openDb(dbPath);
const adapter: CronJobPort = sqliteCronJobAdapter(db);
const now = Date.now();

afterAll(() => {
  db.close();
  try {
    unlinkSync(dbPath);
  } catch {
    /* best-effort cleanup */
  }
});

describe("sqliteCronJobAdapter", () => {
  test("createCronJob and getCronJob", () => {
    const row = adapter.createCronJob({
      cronJobId: "cj-1",
      name: "Daily Patrol",
      agentId: "agent-1",
      cronExpr: "0 9 * * *",
      prompt: "patrol please",
      enabled: true,
      timeoutMs: 60000,
      maxRetries: 3,
      createdAt: now,
      updatedAt: now,
    });
    expect(row.cronJobId).toBe("cj-1");
    expect(row.name).toBe("Daily Patrol");
    expect(row.enabled).toBe(true);
    expect(row.timeoutMs).toBe(60000);
    expect(row.maxRetries).toBe(3);

    const fetched = adapter.getCronJob("cj-1");
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe("Daily Patrol");
    expect(fetched!.enabled).toBe(true); // boolean, not integer
  });

  test("getCronJob returns null for missing", () => {
    expect(adapter.getCronJob("nonexistent")).toBeNull();
  });

  test("listCronJobs and listEnabledCronJobs", () => {
    adapter.createCronJob({
      cronJobId: "cj-2",
      name: "Disabled Job",
      agentId: "agent-1",
      cronExpr: "*/15 * * * *",
      prompt: "check build",
      enabled: false,
      timeoutMs: 0,
      maxRetries: 0,
      createdAt: now,
      updatedAt: now,
    });
    const all = adapter.listCronJobs();
    expect(all.length).toBeGreaterThanOrEqual(2);

    const enabled = adapter.listEnabledCronJobs();
    // Only cj-1 should be enabled
    expect(enabled.every((j) => j.enabled)).toBe(true);
    expect(enabled.find((j) => j.cronJobId === "cj-2")).toBeUndefined();
  });

  test("updateCronJob", () => {
    const updated = adapter.updateCronJob("cj-1", {
      name: "Morning Patrol",
      updatedAt: now + 1000,
    });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("Morning Patrol");
    // Unchanged fields preserved
    expect(updated!.enabled).toBe(true);
    expect(updated!.cronExpr).toBe("0 9 * * *");
  });

  test("updateCronJob returns null for missing", () => {
    expect(adapter.updateCronJob("nonexistent", { name: "x", updatedAt: now })).toBeNull();
  });

  test("updateCronJob with only updatedAt is a no-op read", () => {
    const result = adapter.updateCronJob("cj-1", { updatedAt: now + 2000 });
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Morning Patrol");
  });

  test("deleteCronJob", () => {
    expect(adapter.deleteCronJob("cj-1")).toBe(true);
    expect(adapter.getCronJob("cj-1")).toBeNull();
    expect(adapter.deleteCronJob("nonexistent")).toBe(false);
  });
});
