import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createSqliteCodingTerminalStore } from "./adapter-sqlite.js";

const MIGRATIONS = join(import.meta.dir, "../../../drizzle/backend");

describe("createSqliteCodingTerminalStore (ADR 0082 D3)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeDb() {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(drizzle(db), { migrationsFolder: MIGRATIONS });
    const now = Date.now();
    db.query(
      "INSERT INTO project (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run("p1", "Console", now, now);
    db.query(
      "INSERT INTO requirement (requirement_id, title, goal, status, project_id, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?)",
    ).run("r1", "Ship terminals", "Link terminals", "p1", now, now);
    db.query(
      "INSERT INTO conversation (conversation_id, agent_id, title, origin, current_requirement_id, project_id, created_at) VALUES (?, ?, ?, 'user', ?, ?, ?)",
    ).run("c1", "coder", "Terminal room", "r1", "p1", now);
    return db;
  }

  test("round-trips terminals with conversation and requirement linkage and prunes removed rows", () => {
    const db = makeDb();
    const store = createSqliteCodingTerminalStore(db);
    store.saveAll([
      {
        terminalId: "t-1",
        projectId: "p1",
        agentId: "coder",
        conversationId: "c1",
        requirementId: "r1",
        cwd: "/tmp/p1",
        title: "oma",
        kind: "oma",
      },
    ]);
    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      terminalId: "t-1",
      projectId: "p1",
      conversationId: "c1",
      requirementId: "r1",
      kind: "oma",
    });

    store.saveAll([]);
    expect(store.loadAll()).toEqual([]);
  });

  test("imports legacy terminals.json once when table is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "coding-sql-"));
    dirs.push(dir);
    const jsonFile = join(dir, "terminals.json");
    writeFileSync(
      jsonFile,
      JSON.stringify([
        {
          terminalId: "legacy-1",
          projectId: "p1",
          agentId: "coder",
          cwd: "/tmp/p1",
          title: "bash",
          kind: "shell",
        },
      ]),
    );
    const db = makeDb();
    const store = createSqliteCodingTerminalStore(db);
    expect(store.importLegacyJsonIfEmpty(jsonFile)).toBe(1);
    expect(store.loadAll().map((t) => t.terminalId)).toEqual(["legacy-1"]);
    // Second call is a no-op once rows exist.
    expect(store.importLegacyJsonIfEmpty(jsonFile)).toBe(0);
  });
});
