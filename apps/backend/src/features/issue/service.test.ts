import { describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteIssueAdapter } from "./adapter-sqlite.js";
import { createIssueService, IllegalTransitionError, IssueNotFoundError } from "./service.js";

// openDb runs the drizzle migrations — the issue table + indexes already exist.
const db = openDb(":memory:");
const port = sqliteIssueAdapter(db);

let idCount = 0;
function testIdGen(): string {
  return `test-iss-${idCount++}`;
}

const svc = createIssueService({ port, idGen: testIdGen });

describe("IssueService", () => {
  test("createIssue creates with status=draft and derived sessionId", () => {
    const issue = svc.createIssue({
      projectId: "proj-1",
      title: "Fix login bug",
    });
    expect(issue.issueId).toBe("test-iss-0");
    expect(issue.status).toBe("draft");
    expect(issue.title).toBe("Fix login bug");
    // M19: the run line is the conversation sessionId `<issueId>:<memberId>`
    // (member = the human owner), persisted in the legacy sessionId field.
    expect(issue.sessionId).toBe("test-iss-0");
  });

  test("sessionId is derived as <issueId>:owner", () => {
    const issue = svc.createIssue({
      projectId: "proj-1",
      title: "Thread check",
    });
    expect(issue.sessionId).toBe(issue.issueId);
  });

  test("applyTransition moves draft → planned", () => {
    const issue = svc.createIssue({
      projectId: "proj-1",
      title: "Draft to planned",
    });
    const moved = svc.applyTransition(issue.issueId, "planned");
    expect(moved.status).toBe("planned");
    expect(moved.updatedAt).toBeGreaterThanOrEqual(issue.updatedAt);
  });

  test("applyTransition moves planned → in_progress", () => {
    const issue = svc.createIssue({
      projectId: "proj-1",
      title: "Add dark mode",
    });
    svc.applyTransition(issue.issueId, "planned");
    const moved = svc.applyTransition(issue.issueId, "in_progress");
    expect(moved.status).toBe("in_progress");
    expect(moved.updatedAt).toBeGreaterThanOrEqual(issue.updatedAt);
  });

  test("applyTransition rejects illegal jump (draft → done)", () => {
    const issue = svc.createIssue({
      projectId: "proj-1",
      title: "Jump fail",
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
    });
    svc.applyTransition(issue.issueId, "planned");
    // Trying to go planned → planned — not in LEGAL_TRANSITIONS
    expect(() => svc.applyTransition(issue.issueId, "planned")).toThrow(IllegalTransitionError);
  });

  test("full lifecycle: draft → planned → in_progress → in_review → done", () => {
    const issue = svc.createIssue({
      projectId: "proj-1",
      title: "Full lifecycle",
    });
    expect(issue.status).toBe("draft");

    const step1 = svc.applyTransition(issue.issueId, "planned");
    expect(step1.status).toBe("planned");

    const step2 = svc.applyTransition(issue.issueId, "in_progress");
    expect(step2.status).toBe("in_progress");

    const step3 = svc.applyTransition(issue.issueId, "in_review");
    expect(step3.status).toBe("in_review");

    const step4 = svc.applyTransition(issue.issueId, "done");
    expect(step4.status).toBe("done");

    // done is terminal — no outgoing transitions
    expect(() => svc.applyTransition(issue.issueId, "in_review")).toThrow(IllegalTransitionError);
  });

  test("port is exposed on service", () => {
    expect(svc.port).toBe(port);
  });
});
