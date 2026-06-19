import { afterAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteIssueAdapter } from "../issue/adapter-sqlite.js";
import { sqliteProjectAdapter } from "./adapter-sqlite.js";
import {
  createProjectService,
  ProjectInUseError,
  ProjectNotFoundError,
  ValidationError,
} from "./service.js";

const dbPath = `/tmp/test-project-svc-${Date.now()}.db`;
const db = openDb(dbPath);

// Run migrations for both project and issue tables
db.exec(`
  CREATE TABLE IF NOT EXISTS project (
    project_id     TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    repo_url       TEXT,
    default_branch TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_project_name ON project(name);
  CREATE TABLE IF NOT EXISTS issue (
    issue_id   TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title      TEXT NOT NULL,
    status     TEXT NOT NULL,
    thread_id  TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_issue_project ON issue(project_id);
`);

const port = sqliteProjectAdapter(db);
const issuePort = sqliteIssueAdapter(db);

let idCount = 0;
function testIdGen(): string {
  return `test-prj-${idCount++}`;
}

const svc = createProjectService({ port, idGen: testIdGen });

afterAll(() => {
  db.close();
  try {
    unlinkSync(dbPath);
  } catch {
    /* best-effort */
  }
});

describe("ProjectService", () => {
  test("create project", () => {
    const p = svc.createProject({ name: "my-project" });
    expect(p.name).toBe("my-project");
    expect(p.projectId).toStartWith("test-prj-");
    expect(p.repoUrl).toBeNull();
    expect(p.defaultBranch).toBeNull();
    expect(p.createdAt).toBeGreaterThan(0);
  });

  test("create project with git metadata", () => {
    const p = svc.createProject({
      name: "with-git",
      repoUrl: "https://github.com/org/repo.git",
      defaultBranch: "main",
    });
    expect(p.repoUrl).toBe("https://github.com/org/repo.git");
    expect(p.defaultBranch).toBe("main");
  });

  test("create project with empty name throws", () => {
    expect(() => svc.createProject({ name: "" })).toThrow(ValidationError);
    expect(() => svc.createProject({ name: "  " })).toThrow(ValidationError);
  });

  test("duplicate name throws ValidationError", () => {
    const name = `dup-${Date.now()}`;
    svc.createProject({ name });
    expect(() => svc.createProject({ name })).toThrow(ValidationError);
  });

  test("getById returns project", () => {
    const created = svc.createProject({ name: `get-${Date.now()}` });
    const found = svc.getById(created.projectId);
    expect(found.projectId).toBe(created.projectId);
    expect(found.name).toBe(created.name);
  });

  test("getById throws ProjectNotFoundError for missing", () => {
    expect(() => svc.getById("nonexistent")).toThrow(ProjectNotFoundError);
  });

  test("list returns projects ordered by created_at DESC", async () => {
    const p1 = svc.createProject({ name: `list-1-${Date.now()}` });
    // Ensure distinct timestamps for deterministic ordering
    await new Promise((r) => setTimeout(r, 1));
    const p2 = svc.createProject({ name: `list-2-${Date.now()}` });
    const all = svc.list();
    const idx1 = all.findIndex((p) => p.projectId === p1.projectId);
    const idx2 = all.findIndex((p) => p.projectId === p2.projectId);
    expect(idx1).not.toBe(-1);
    expect(idx2).not.toBe(-1);
    // p2 created later — should appear before p1 in DESC order
    expect(idx2).toBeLessThan(idx1);
  });

  test("exists returns true/false", () => {
    const p = svc.createProject({ name: `exists-${Date.now()}` });
    expect(svc.exists(p.projectId)).toBe(true);
    expect(svc.exists("nonexistent")).toBe(false);
  });

  test("update changes fields", () => {
    const p = svc.createProject({ name: `update-${Date.now()}` });
    const updated = svc.update(p.projectId, { name: "renamed", defaultBranch: "develop" });
    expect(updated.name).toBe("renamed");
    expect(updated.defaultBranch).toBe("develop");
    // Verify persistence
    const reloaded = svc.getById(p.projectId);
    expect(reloaded.name).toBe("renamed");
  });

  test("update with empty name throws", () => {
    const p = svc.createProject({ name: `update-err-${Date.now()}` });
    expect(() => svc.update(p.projectId, { name: "" })).toThrow(ValidationError);
  });

  test("update non-existent throws ProjectNotFoundError", () => {
    expect(() => svc.update("nonexistent", { name: "x" })).toThrow(ProjectNotFoundError);
  });

  test("update to duplicate name throws ValidationError", () => {
    const p1 = svc.createProject({ name: `dup-update-1-${Date.now()}` });
    const p2 = svc.createProject({ name: `dup-update-2-${Date.now()}` });
    expect(() => svc.update(p2.projectId, { name: p1.name })).toThrow(ValidationError);
  });

  test("remove succeeds when no issues", () => {
    const p = svc.createProject({ name: `remove-${Date.now()}` });
    svc.remove(p.projectId);
    expect(svc.exists(p.projectId)).toBe(false);
  });

  test("remove throws ProjectInUseError when issues exist", () => {
    const p = svc.createProject({ name: `in-use-${Date.now()}` });
    // Create an issue under this project
    issuePort.createIssue({
      issueId: `iss-${Date.now()}`,
      projectId: p.projectId,
      title: "test",
      threadId: "thread:test",
      createdAt: Date.now(),
    });
    expect(() => svc.remove(p.projectId)).toThrow(ProjectInUseError);
  });

  test("remove throws ProjectNotFoundError for missing", () => {
    expect(() => svc.remove("nonexistent")).toThrow(ProjectNotFoundError);
  });

  test("port is exposed", () => {
    expect(svc.port).toBe(port);
  });
});
