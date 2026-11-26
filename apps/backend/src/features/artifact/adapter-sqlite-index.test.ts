import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createEntityLabelResolver } from "../../infra/entity-labels.js";
import { createArtifactFsAdapter } from "./adapter-fs.js";
import { createSqliteArtifactIndexAdapter } from "./adapter-sqlite-index.js";

const MIGRATIONS = join(import.meta.dir, "../../../drizzle/backend");

describe("createSqliteArtifactIndexAdapter (ADR 0082 D1)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "artifact-idx-"));
    dirs.push(dir);
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(drizzle(db), { migrationsFolder: MIGRATIONS });
    const now = Date.now();
    db.query(
      "INSERT INTO agents (id, workspace_path, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("coder", "/tmp/w-coder", JSON.stringify({ name: "Coder" }), now, now);
    db.query(
      "INSERT INTO project (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run("p1", "Console", now, now);
    db.query(
      "INSERT INTO requirement (requirement_id, title, goal, status, project_id, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?)",
    ).run("req1", "Login Redesign", "Rebuild login page", "p1", now, now);
    db.query(
      "INSERT INTO conversation (conversation_id, agent_id, title, origin, current_requirement_id, project_id, created_at) VALUES (?, ?, ?, 'user', ?, ?, ?)",
    ).run("conv1", "coder", "Fix login UX", "req1", "p1", now);

    const inner = createArtifactFsAdapter(join(dir, "artifacts"));
    const labelResolver = createEntityLabelResolver(db);
    const indexed = createSqliteArtifactIndexAdapter({ inner, db, labelResolver });
    return { db, inner, indexed };
  }

  test("freezes inherited requirement/project/agent from conversation and filters by them", async () => {
    const { indexed } = setup();
    const uploaded = await indexed.put({
      folder: "reports",
      filename: "summary.md",
      content: "# Done",
      source: { conversationId: "conv1" },
    });
    expect(uploaded.source?.requirementId).toBe("req1");
    expect(uploaded.source?.projectId).toBe("p1");
    expect(uploaded.source?.agentId).toBe("coder");
    expect(uploaded.labels).toEqual({
      agentName: "Coder",
      conversationTitle: "Fix login UX",
      requirementTitle: "Login Redesign",
      projectName: "Console",
    });

    await indexed.put({
      folder: "uploads",
      filename: "manual.txt",
      content: "standalone",
    });

    const byReq = await indexed.list({ requirementId: "req1" });
    expect(byReq.map((a) => a.url)).toEqual(["artifacts://reports/summary.md"]);
    expect(byReq[0]?.labels?.requirementTitle).toBe("Login Redesign");

    const byConv = await indexed.list({ conversationId: "conv1", requirementId: "req1" });
    expect(byConv).toHaveLength(1);

    const meta = await indexed.getMeta!("artifacts://reports/summary.md");
    expect(meta?.labels?.conversationTitle).toBe("Fix login UX");

    await indexed.delete("artifacts://reports/summary.md");
    expect(await indexed.list({ requirementId: "req1" })).toEqual([]);
  });

  test("backfills existing disk artifacts and preserves ON DELETE SET NULL", async () => {
    const { db, inner, indexed } = setup();
    await inner.put({
      folder: "legacy",
      filename: "old.md",
      content: "legacy doc",
      source: { conversationId: "conv1" },
    });
    expect(await indexed.list()).toHaveLength(0);

    const added = await indexed.backfill!();
    expect(added).toBe(1);
    const listed = await indexed.list({ requirementId: "req1" });
    expect(listed.map((a) => a.filename)).toEqual(["old.md"]);

    // Second backfill is idempotent.
    expect(await indexed.backfill!()).toBe(0);

    // Deleting the requirement sets requirement_id = NULL without dropping the artifact row.
    db.query(
      "UPDATE conversation SET current_requirement_id = NULL WHERE conversation_id = 'conv1'",
    ).run();
    db.query("DELETE FROM requirement WHERE requirement_id = 'req1'").run();
    const afterDelete = await indexed.getMeta!("artifacts://legacy/old.md");
    expect(afterDelete).not.toBeNull();
    expect(afterDelete?.source?.requirementId).toBeUndefined();
  });
});
