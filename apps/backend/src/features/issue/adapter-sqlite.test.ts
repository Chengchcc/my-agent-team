import { afterAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteIssueAdapter } from "./adapter-sqlite.js";

const dbPath = `/tmp/test-issue-adapter-${Date.now()}.db`;
const db = openDb(dbPath);
const adapter = sqliteIssueAdapter(db);

afterAll(() => {
  db.close();
  try {
    unlinkSync(dbPath);
  } catch {
    /* best-effort cleanup */
  }
});

describe("Issue adapter CRUD", () => {
  test("createIssue inserts a row with status=planned", () => {
    const issue = adapter.createIssue({
      issueId: "iss-1",
      projectId: "proj-1",
      title: "Fix login bug",
      threadId: "th-1",
      createdAt: 1700000000000,
    });
    expect(issue.issueId).toBe("iss-1");
    expect(issue.status).toBe("planned");
    expect(issue.title).toBe("Fix login bug");
    expect(issue.createdAt).toBe(1700000000000);
    expect(issue.updatedAt).toBe(1700000000000);
  });

  test("getIssue returns issue or null", () => {
    const issue = adapter.getIssue("iss-1");
    expect(issue).not.toBeNull();
    expect(issue?.issueId).toBe("iss-1");
    expect(adapter.getIssue("nope")).toBeNull();
  });

  test("listIssues returns all issues ordered by created_at DESC", () => {
    adapter.createIssue({
      issueId: "iss-2",
      projectId: "proj-1",
      title: "Add dark mode",
      threadId: "th-2",
      createdAt: 1700000001000,
    });
    const all = adapter.listIssues();
    expect(all).toHaveLength(2);
    expect(all[0]?.issueId).toBe("iss-2");
    expect(all[1]?.issueId).toBe("iss-1");
  });

  test("listIssues filters by projectId", () => {
    adapter.createIssue({
      issueId: "iss-3",
      projectId: "proj-2",
      title: "Other project",
      threadId: "th-3",
      createdAt: 1700000002000,
    });
    const proj1 = adapter.listIssues({ projectId: "proj-1" });
    expect(proj1).toHaveLength(2);
    expect(proj1.map((i) => i.issueId).sort()).toEqual(["iss-1", "iss-2"]);
  });

  test("setStatus updates status with CAS and returns true on match", () => {
    const ok = adapter.setStatus("iss-1", "planned", "in_progress", 1700000100000);
    expect(ok).toBe(true);
    const issue = adapter.getIssue("iss-1");
    expect(issue?.status).toBe("in_progress");
    expect(issue?.updatedAt).toBe(1700000100000);
  });

  test("setStatus returns false when expectFrom does not match (CAS fail)", () => {
    const ok = adapter.setStatus("iss-1", "planned", "done", 1700000200000);
    expect(ok).toBe(false);
    const issue = adapter.getIssue("iss-1");
    expect(issue?.status).toBe("in_progress");
  });

  test("setStatus returns false for nonexistent issue", () => {
    const ok = adapter.setStatus("nope", "planned", "in_progress", 1700000300000);
    expect(ok).toBe(false);
  });
});
