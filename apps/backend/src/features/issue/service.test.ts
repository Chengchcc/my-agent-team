import { afterAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteIssueAdapter } from "./adapter-sqlite.js";
import { createIssueService, IllegalTransitionError, IssueNotFoundError } from "./service.js";

const dbPath = `/tmp/test-issue-svc-${Date.now()}.db`;
const db = openDb(dbPath);
const port = sqliteIssueAdapter(db);

let idCount = 0;
function testIdGen(): string {
  return `test-iss-${idCount++}`;
}

const svc = createIssueService({ port, idGen: testIdGen });

afterAll(() => {
  db.close();
  try {
    unlinkSync(dbPath);
  } catch {
    /* best-effort cleanup */
  }
});

describe("IssueService", () => {
  test("createIssue creates with status=planned", () => {
    const issue = svc.createIssue({
      projectId: "proj-1",
      title: "Fix login bug",
      threadId: "th-1",
    });
    expect(issue.issueId).toBe("test-iss-0");
    expect(issue.status).toBe("planned");
    expect(issue.title).toBe("Fix login bug");
  });

  test("applyTransition moves planned → in_progress", () => {
    const issue = svc.createIssue({
      projectId: "proj-1",
      title: "Add dark mode",
      threadId: "th-2",
    });
    const moved = svc.applyTransition(issue.issueId, "in_progress");
    expect(moved.status).toBe("in_progress");
    expect(moved.updatedAt).toBeGreaterThanOrEqual(issue.updatedAt);
  });

  test("applyTransition rejects illegal jump (planned → done)", () => {
    const issue = svc.createIssue({
      projectId: "proj-1",
      title: "Jump fail",
      threadId: "th-3",
    });
    expect(() => svc.applyTransition(issue.issueId, "done")).toThrow(IllegalTransitionError);
  });

  test("applyTransition throws IssueNotFoundError for nonexistent", () => {
    expect(() => svc.applyTransition("nope", "in_progress")).toThrow(IssueNotFoundError);
  });

  test("idempotent transition: moving to current state fails", () => {
    const issue = svc.createIssue({
      projectId: "proj-1",
      title: "Idempotent test",
      threadId: "th-5",
    });
    svc.applyTransition(issue.issueId, "in_progress");
    // Trying to go in_progress → in_progress — not in LEGAL_TRANSITIONS
    expect(() => svc.applyTransition(issue.issueId, "in_progress")).toThrow(IllegalTransitionError);
  });

  test("full lifecycle: planned → in_progress → in_review → done", () => {
    const issue = svc.createIssue({
      projectId: "proj-1",
      title: "Full lifecycle",
      threadId: "th-6",
    });
    expect(issue.status).toBe("planned");

    const step1 = svc.applyTransition(issue.issueId, "in_progress");
    expect(step1.status).toBe("in_progress");

    const step2 = svc.applyTransition(issue.issueId, "in_review");
    expect(step2.status).toBe("in_review");

    const step3 = svc.applyTransition(issue.issueId, "done");
    expect(step3.status).toBe("done");

    // done is terminal — no outgoing transitions
    expect(() => svc.applyTransition(issue.issueId, "in_review")).toThrow(IllegalTransitionError);
  });

  test("port is exposed on service", () => {
    expect(svc.port).toBe(port);
  });
});
