import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createDeliverableService, sqliteDeliverableAdapter } from "../deliverable/index.js";
import { runEventsDbMigrations } from "../run/events-db-migrations.js";
import { RuntimeOpsStore } from "../runtime-ops/store.js";
import { issueRoutes } from "./http.js";
import { createIssueService, sqliteIssueAdapter } from "./index.js";

function setup() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS issue (
      issue_id   TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title      TEXT NOT NULL,
      status     TEXT NOT NULL,
      thread_id  TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deliverable (
      deliverable_id TEXT PRIMARY KEY,
      issue_id       TEXT NOT NULL,
      from_status    TEXT NOT NULL,
      kind           TEXT NOT NULL,
      fields         TEXT NOT NULL,
      ref            TEXT,
      run_id         TEXT,
      created_at     INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_deliverable_run_kind ON deliverable(run_id, kind) WHERE run_id IS NOT NULL;
  `);

  const eventsDb = new Database(":memory:");
  runEventsDbMigrations(eventsDb);
  const opsStore = new RuntimeOpsStore(eventsDb);

  let idCounter = 0;
  const idGen = () => `id_${String(++idCounter).padStart(3, "0")}`;

  const issueSvc = createIssueService({
    port: sqliteIssueAdapter(db),
    idGen,
    now: () => 1000 + idCounter,
  });

  const deliverableSvc = createDeliverableService({
    port: sqliteDeliverableAdapter(db),
    idGen,
    now: () => 1000 + idCounter,
  });

  let startedIssue: unknown = null;
  let rejectedIssue: unknown = null;

  const routes = issueRoutes(issueSvc, opsStore, deliverableSvc, {
    onIssueStarted: async (issue) => {
      startedIssue = issue;
    },
    onReviewRejected: async (issue) => {
      rejectedIssue = issue;
    },
  });

  return {
    db,
    eventsDb,
    opsStore,
    issueSvc,
    deliverableSvc,
    routes,
    getStartedIssue: () => startedIssue,
    getRejectedIssue: () => rejectedIssue,
  };
}

function makeRequest(path: string, body: unknown, method = "POST"): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

function makeDeliverableRequest(issueId: string, body: unknown): Request {
  return makeRequest(`/api/issues/${issueId}/deliverables`, body);
}

function makeReviewRequest(issueId: string, body: unknown): Request {
  return makeRequest(`/api/issues/${issueId}/review-decision`, body);
}

describe("submitDeliverable", () => {
  test("creates a deliverable and returns 201 with replay=false", async () => {
    const { issueSvc, routes } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });

    const res = await routes.submitDeliverable(
      makeDeliverableRequest(issue.issueId, {
        kind: "plan",
        fields: { summary: "hello" },
      }),
      issue.issueId,
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { deliverable: { kind: string } };
    expect(body.deliverable.kind).toBe("plan");
  });

  test("returns 400 on invalid kind", async () => {
    const { issueSvc, routes } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });

    const res = await routes.submitDeliverable(
      makeDeliverableRequest(issue.issueId, {
        kind: "INVALID_KIND",
        fields: {},
      }),
      issue.issueId,
    );
    expect(res.status).toBe(400);
  });

  test("returns 404 for unknown issue", async () => {
    const { routes } = setup();
    const res = await routes.submitDeliverable(
      makeDeliverableRequest("nonexistent", { kind: "plan", fields: {} }),
      "nonexistent",
    );
    expect(res.status).toBe(404);
  });

  test("returns 200(replay) on duplicate (runId, kind)", async () => {
    const { issueSvc, opsStore, routes } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });

    // Insert run_origin so R3 validation passes
    opsStore.insertRunOrigin({
      runId: "run_001",
      issueId: issue.issueId,
      conversationId: "",
      sourceLedgerSeq: 0,
      agentMemberId: "agent1",
      surface: "orchestrator",
      traceId: "",
      traceparent: "",
      idempotencyKey: "run_001",
      fromStatus: "planned",
      createdAt: 1000,
    });

    await routes.submitDeliverable(
      makeDeliverableRequest(issue.issueId, {
        kind: "plan",
        fields: { v: "1" },
        runId: "run_001",
      }),
      issue.issueId,
    );
    const res2 = await routes.submitDeliverable(
      makeDeliverableRequest(issue.issueId, {
        kind: "plan",
        fields: { v: "2" },
        runId: "run_001",
      }),
      issue.issueId,
    );
    expect(res2.status).toBe(200);
    const body = await res2.json() as { deliverable: { fields: Record<string, string> } };
    expect(body.deliverable.fields).toEqual({ v: "1" }); // first write wins
  });

  test("returns 409 when runId refers to unknown run (R3)", async () => {
    const { issueSvc, routes } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });

    const res = await routes.submitDeliverable(
      makeDeliverableRequest(issue.issueId, {
        kind: "plan",
        fields: {},
        runId: "nonexistent_run",
      }),
      issue.issueId,
    );
    expect(res.status).toBe(409);
  });

  test("returns 409 when runId's issueId mismatches (R3 cross-issue guard)", async () => {
    const { issueSvc, opsStore, routes } = setup();
    const issue1 = issueSvc.createIssue({ projectId: "p1", title: "Issue 1" });
    const issue2 = issueSvc.createIssue({ projectId: "p1", title: "Issue 2" });

    opsStore.insertRunOrigin({
      runId: "run_x",
      issueId: issue2.issueId,
      conversationId: "",
      sourceLedgerSeq: 0,
      agentMemberId: "agent1",
      surface: "orchestrator",
      traceId: "",
      traceparent: "",
      idempotencyKey: "run_x",
      fromStatus: "planned",
      createdAt: 1000,
    });

    const res = await routes.submitDeliverable(
      makeDeliverableRequest(issue1.issueId, {
        kind: "plan",
        fields: {},
        runId: "run_x",
      }),
      issue1.issueId,
    );
    expect(res.status).toBe(409);
  });
});

describe("reviewDecision", () => {
  test("approve: in_review → done, 200", async () => {
    const { issueSvc, routes } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });
    issueSvc.applyTransition(issue.issueId, "planned");
    issueSvc.applyTransition(issue.issueId, "in_progress");
    const review = issueSvc.applyTransition(issue.issueId, "in_review");
    expect(review.status).toBe("in_review");

    const res = await routes.reviewDecision(
      makeReviewRequest(issue.issueId, { decision: "approve" }),
      issue.issueId,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { issue: { status: string } };
    expect(body.issue.status).toBe("done");
  });

  test("reject with note: writes rework_feedback + in_review→in_progress + triggers onReviewRejected", async () => {
    const { issueSvc, deliverableSvc, routes, getRejectedIssue } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });
    issueSvc.applyTransition(issue.issueId, "planned");
    issueSvc.applyTransition(issue.issueId, "in_progress");
    issueSvc.applyTransition(issue.issueId, "in_review");

    const res = await routes.reviewDecision(
      makeReviewRequest(issue.issueId, { decision: "reject", note: "Needs more tests" }),
      issue.issueId,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { issue: { status: string } };
    expect(body.issue.status).toBe("in_progress");

    // rework_feedback deliverable written
    const deliverables = deliverableSvc.listByIssue(issue.issueId);
    const feedback = deliverables.find((d) => d.kind === "rework_feedback");
    expect(feedback).toBeDefined();
    expect(feedback!.fields.note).toBe("Needs more tests");
    expect(feedback!.runId).toBeNull(); // human-produced, no runId

    // onReviewRejected called
    expect(getRejectedIssue()).not.toBeNull();
  });

  test("reject without note → 400", async () => {
    const { issueSvc, routes } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });
    issueSvc.applyTransition(issue.issueId, "planned");
    issueSvc.applyTransition(issue.issueId, "in_progress");
    issueSvc.applyTransition(issue.issueId, "in_review");

    const res = await routes.reviewDecision(
      makeReviewRequest(issue.issueId, { decision: "reject" }),
      issue.issueId,
    );
    expect(res.status).toBe(400);
  });

  test("non-in_review status → 409", async () => {
    const { issueSvc, routes } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });
    // still draft — not in_review

    const res = await routes.reviewDecision(
      makeReviewRequest(issue.issueId, { decision: "approve" }),
      issue.issueId,
    );
    expect(res.status).toBe(409);
  });

  test("nonexistent issue → 404", async () => {
    const { routes } = setup();
    const res = await routes.reviewDecision(
      makeReviewRequest("nonexistent", { decision: "approve" }),
      "nonexistent",
    );
    expect(res.status).toBe(404);
  });

  test("invalid decision → 400", async () => {
    const { routes } = setup();
    const res = await routes.reviewDecision(
      makeReviewRequest("issue_001", { decision: "invalid" }),
      "issue_001",
    );
    expect(res.status).toBe(400);
  });

  test("in_review→in_progress is a legal transition (backward edge belongs to LEGAL_TRANSITIONS)", async () => {
    const { issueSvc, routes } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });
    issueSvc.applyTransition(issue.issueId, "planned");
    issueSvc.applyTransition(issue.issueId, "in_progress");
    issueSvc.applyTransition(issue.issueId, "in_review");

    // This must NOT throw IllegalTransitionError
    const res = await routes.reviewDecision(
      makeReviewRequest(issue.issueId, { decision: "reject", note: "Redo" }),
      issue.issueId,
    );
    expect(res.status).toBe(200);
  });
});
