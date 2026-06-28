import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { openDb } from "../../infra/sqlite/db.js";
import { createDeliverableService, sqliteDeliverableAdapter } from "../deliverable/index.js";
import { RuntimeOpsStore } from "../runtime-ops/store.js";
import { issueRoutes } from "./http.js";
import { createIssueService, sqliteIssueAdapter } from "./index.js";

function setup() {
  // S1: events.db merged into backend.db — single openDb call creates all tables.
  const db = openDb(":memory:");
  const opsStore = new RuntimeOpsStore(db);

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

  const app = new Elysia().use(
    issueRoutes(issueSvc, opsStore, deliverableSvc, {
      onIssueStarted: async (issue) => {
        startedIssue = issue;
      },
      onReviewRejected: async (issue) => {
        rejectedIssue = issue;
      },
    }),
  );

  return {
    db,
    opsStore,
    issueSvc,
    deliverableSvc,
    app,
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

describe("HTTP emission events", () => {
  test("create handler emits created event", async () => {
    const { opsStore, app } = setup();
    const res = await app.handle(
      new Request("http://localhost/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "p1", title: "Emit Test" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { issue: { issueId: string } };
    const events = opsStore.getIssueEvents(body.issue.issueId);
    const created = events.find((e) => e.kind === "created");
    expect(created).toBeDefined();
    expect(created!.payload.title).toBe("Emit Test");
    expect(created!.payload.projectId).toBe("p1");
  });

  test("transition emits status.advanced(by:human) + started on draft→planned", async () => {
    const { issueSvc, opsStore, app } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });

    const res = await app.handle(
      new Request(`http://localhost/api/issues/${issue.issueId}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "planned" }),
      }),
    );
    expect(res.status).toBe(200);
    const events = opsStore.getIssueEvents(issue.issueId);
    const adv = events.find(
      (e) => e.kind === "status.advanced" && e.payload.by === "human" && e.payload.to === "planned",
    );
    expect(adv).toBeDefined();
    const started = events.find((e) => e.kind === "started");
    expect(started).toBeDefined();
    expect(started!.payload.from).toBe("draft");
    expect(started!.payload.to).toBe("planned");
  });
});

describe("submitDeliverable", () => {
  test("creates a deliverable and returns 201 with replay=false", async () => {
    const { issueSvc, app } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });

    const res = await app.handle(
      makeDeliverableRequest(issue.issueId, {
        kind: "plan",
        fields: { summary: "hello" },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { deliverable: { kind: string } };
    expect(body.deliverable.kind).toBe("plan");
  });

  test("returns 400 on invalid kind", async () => {
    const { issueSvc, app } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });

    const res = await app.handle(
      makeDeliverableRequest(issue.issueId, {
        kind: "INVALID_KIND",
        fields: {},
      }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 404 for unknown issue", async () => {
    const { app } = setup();
    const res = await app.handle(
      makeDeliverableRequest("nonexistent", { kind: "plan", fields: {} }),
    );
    expect(res.status).toBe(404);
  });

  test("returns 200(replay) on duplicate (spanId, kind)", async () => {
    const { issueSvc, opsStore, app } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });

    // Insert run_origin so R3 validation passes
    opsStore.insertSpanOrigin({
      spanId: "run_001",
      issueId: issue.issueId,
      conversationId: "",
      sourceLedgerSeq: 0,
      agentMemberId: "agent1",
      surface: "orchestrator",
      traceId: "",
      traceparent: "",
      idempotencyKey: "run_001",
      originKind: "orchestrator",
      fromStatus: "planned",
      createdAt: 1000,
    });

    await app.handle(
      makeDeliverableRequest(issue.issueId, {
        kind: "plan",
        fields: { v: "1" },
        spanId: "run_001",
      }),
    );
    const res2 = await app.handle(
      makeDeliverableRequest(issue.issueId, {
        kind: "plan",
        fields: { v: "2" },
        spanId: "run_001",
      }),
    );
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as { deliverable: { fields: Record<string, string> } };
    expect(body.deliverable.fields).toEqual({ v: "1" }); // first write wins
  });

  test("returns 409 when spanId refers to unknown run (R3)", async () => {
    const { issueSvc, app } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });

    const res = await app.handle(
      makeDeliverableRequest(issue.issueId, {
        kind: "plan",
        fields: {},
        spanId: "nonexistent_run",
      }),
    );
    expect(res.status).toBe(409);
  });

  test("emits deliverable.submitted event (non-replay only)", async () => {
    const { issueSvc, opsStore, app } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });

    await app.handle(
      makeDeliverableRequest(issue.issueId, {
        kind: "plan",
        fields: { x: "1" },
      }),
    );
    const events = opsStore.getIssueEvents(issue.issueId);
    const ds = events.filter((e) => e.kind === "deliverable.submitted");
    expect(ds.length).toBe(1);
    expect(ds[0]!.payload.kind).toBe("plan");
    expect(ds[0]!.payload.deliverableId).toBeString();
  });

  test("returns 409 when spanId's issueId mismatches (R3 cross-issue guard)", async () => {
    const { issueSvc, opsStore, app } = setup();
    const issue1 = issueSvc.createIssue({ projectId: "p1", title: "Issue 1" });
    const issue2 = issueSvc.createIssue({ projectId: "p1", title: "Issue 2" });

    opsStore.insertSpanOrigin({
      spanId: "run_x",
      issueId: issue2.issueId,
      conversationId: "",
      sourceLedgerSeq: 0,
      agentMemberId: "agent1",
      surface: "orchestrator",
      traceId: "",
      traceparent: "",
      idempotencyKey: "run_x",
      originKind: "orchestrator",
      fromStatus: "planned",
      createdAt: 1000,
    });

    const res = await app.handle(
      makeDeliverableRequest(issue1.issueId, {
        kind: "plan",
        fields: {},
        spanId: "run_x",
      }),
    );
    expect(res.status).toBe(409);
  });
});

describe("reviewDecision", () => {
  test("approve: in_review → done, 200", async () => {
    const { issueSvc, app } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });
    issueSvc.applyTransition(issue.issueId, "planned");
    issueSvc.applyTransition(issue.issueId, "in_progress");
    const review = issueSvc.applyTransition(issue.issueId, "in_review");
    expect(review.status).toBe("in_review");

    const res = await app.handle(makeReviewRequest(issue.issueId, { decision: "approve" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issue: { status: string } };
    expect(body.issue.status).toBe("done");
  });

  test("reject with note: writes rework_feedback + in_review→in_progress + triggers onReviewRejected", async () => {
    const { issueSvc, deliverableSvc, app, getRejectedIssue } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });
    issueSvc.applyTransition(issue.issueId, "planned");
    issueSvc.applyTransition(issue.issueId, "in_progress");
    issueSvc.applyTransition(issue.issueId, "in_review");

    const res = await app.handle(
      makeReviewRequest(issue.issueId, { decision: "reject", note: "Needs more tests" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issue: { status: string } };
    expect(body.issue.status).toBe("in_progress");

    // rework_feedback deliverable written
    const deliverables = deliverableSvc.listByIssue(issue.issueId);
    const feedback = deliverables.find((d) => d.kind === "rework_feedback");
    expect(feedback).toBeDefined();
    expect(feedback!.fields.note).toBe("Needs more tests");
    expect(feedback!.spanId).toBeNull(); // human-produced, no spanId

    // onReviewRejected called
    expect(getRejectedIssue()).not.toBeNull();
  });

  test("reject without note → 400", async () => {
    const { issueSvc, app } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });
    issueSvc.applyTransition(issue.issueId, "planned");
    issueSvc.applyTransition(issue.issueId, "in_progress");
    issueSvc.applyTransition(issue.issueId, "in_review");

    const res = await app.handle(makeReviewRequest(issue.issueId, { decision: "reject" }));
    expect(res.status).toBe(400);
  });

  test("non-in_review status → 409", async () => {
    const { issueSvc, app } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });
    // still draft — not in_review

    const res = await app.handle(makeReviewRequest(issue.issueId, { decision: "approve" }));
    expect(res.status).toBe(409);
  });

  test("nonexistent issue → 404", async () => {
    const { app } = setup();
    const res = await app.handle(makeReviewRequest("nonexistent", { decision: "approve" }));
    expect(res.status).toBe(404);
  });

  test("invalid decision → 400", async () => {
    const { app } = setup();
    const res = await app.handle(makeReviewRequest("issue_001", { decision: "invalid" }));
    expect(res.status).toBe(400);
  });

  test("approve emits human.decided + status.advanced(by:human)", async () => {
    const { issueSvc, opsStore, app } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });
    issueSvc.applyTransition(issue.issueId, "planned");
    issueSvc.applyTransition(issue.issueId, "in_progress");
    issueSvc.applyTransition(issue.issueId, "in_review");

    await app.handle(makeReviewRequest(issue.issueId, { decision: "approve" }));
    const events = opsStore.getIssueEvents(issue.issueId);
    expect(
      events.find((e) => e.kind === "human.decided" && e.payload.decision === "approve"),
    ).toBeDefined();
    expect(
      events.find(
        (e) => e.kind === "status.advanced" && e.payload.by === "human" && e.payload.to === "done",
      ),
    ).toBeDefined();
  });

  test("reject emits human.decided + status.advanced(by:rework) + deliverable.submitted for rework_feedback", async () => {
    const { issueSvc, opsStore, app } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });
    issueSvc.applyTransition(issue.issueId, "planned");
    issueSvc.applyTransition(issue.issueId, "in_progress");
    issueSvc.applyTransition(issue.issueId, "in_review");

    await app.handle(makeReviewRequest(issue.issueId, { decision: "reject", note: "try again" }));
    const events = opsStore.getIssueEvents(issue.issueId);
    expect(
      events.find((e) => e.kind === "human.decided" && e.payload.decision === "reject"),
    ).toBeDefined();
    expect(
      events.find((e) => e.kind === "status.advanced" && e.payload.by === "rework"),
    ).toBeDefined();
    const ds = events.find(
      (e) => e.kind === "deliverable.submitted" && e.payload.kind === "rework_feedback",
    );
    expect(ds).toBeDefined();
  });

  test("in_review→in_progress is a legal transition (backward edge belongs to LEGAL_TRANSITIONS)", async () => {
    const { issueSvc, app } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });
    issueSvc.applyTransition(issue.issueId, "planned");
    issueSvc.applyTransition(issue.issueId, "in_progress");
    issueSvc.applyTransition(issue.issueId, "in_review");

    // This must NOT throw IllegalTransitionError
    const res = await app.handle(
      makeReviewRequest(issue.issueId, { decision: "reject", note: "Redo" }),
    );
    expect(res.status).toBe(200);
  });
});

describe("reject rollback", () => {
  test("reject with failing onReviewRejected → 502 + issue rolled back to in_review", async () => {
    const { issueSvc, opsStore, deliverableSvc } = setup();

    // Build routes with a throwing onReviewRejected callback
    const app = new Elysia().use(
      issueRoutes(issueSvc, opsStore, deliverableSvc, {
        onReviewRejected: async () => {
          throw new Error("agent archived");
        },
      }),
    );

    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });
    issueSvc.applyTransition(issue.issueId, "planned");
    issueSvc.applyTransition(issue.issueId, "in_progress");
    issueSvc.applyTransition(issue.issueId, "in_review");

    const res = await app.handle(
      makeReviewRequest(issue.issueId, { decision: "reject", note: "try again" }),
    );
    expect(res.status).toBe(502);

    // Issue must be back in in_review (compensation rollback succeeded)
    const reverted = issueSvc.port.getIssue(issue.issueId);
    expect(reverted!.status).toBe("in_review");
  });
});

describe("timeline endpoint", () => {
  test("GET /timeline returns events ordered by seq", async () => {
    const { issueSvc, opsStore, app } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });
    opsStore.appendIssueEvent({ issueId: issue.issueId, kind: "created" });
    opsStore.appendIssueEvent({ issueId: issue.issueId, kind: "started" });

    const res = await app.handle(
      new Request(`http://localhost/api/issues/${issue.issueId}/timeline`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ kind: string }> };
    expect(body.events.length).toBe(2);
    expect(body.events[0]!.kind).toBe("created");
    expect(body.events[1]!.kind).toBe("started");
  });

  test("GET /timeline returns 404 for unknown issue", async () => {
    const { app } = setup();
    const res = await app.handle(new Request("http://localhost/api/issues/nonexistent/timeline"));
    expect(res.status).toBe(404);
  });
});

describe("detail endpoint", () => {
  test("GET /detail returns {issue, timeline, runs}", async () => {
    const { issueSvc, opsStore, app } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });
    opsStore.appendIssueEvent({ issueId: issue.issueId, kind: "created" });

    const res = await app.handle(
      new Request(`http://localhost/api/issues/${issue.issueId}/detail`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issue: { issueId: string };
      timeline: unknown[];
      runs: unknown[];
    };
    expect(body.issue.issueId).toBe(issue.issueId);
    expect(body.timeline.length).toBe(1);
    expect(Array.isArray(body.runs)).toBe(true);
  });

  test("GET /detail returns 404 for unknown issue", async () => {
    const { app } = setup();
    const res = await app.handle(new Request("http://localhost/api/issues/nonexistent/detail"));
    expect(res.status).toBe(404);
  });

  test("GET /detail runs array includes run status from run table", async () => {
    const { db, issueSvc, opsStore, app } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });

    opsStore.insertSpanOrigin({
      spanId: "r_detail",
      issueId: issue.issueId,
      conversationId: "",
      sourceLedgerSeq: 0,
      agentMemberId: "a1",
      surface: "orchestrator",
      traceId: "",
      traceparent: "",
      idempotencyKey: "r_detail",
      originKind: "orchestrator",
      fromStatus: "planned",
      createdAt: 1000,
    });
    db.run(
      `INSERT INTO run (span_id, session_id, agent_id, status, started_at, ended_at) VALUES ('r_detail', 't1', 'a1', 'succeeded', 1000, 5000)`,
    );

    const res = await app.handle(
      new Request(`http://localhost/api/issues/${issue.issueId}/detail`),
    );
    const body = (await res.json()) as {
      runs: Array<{ spanId: string; status: string; endedAt: number | null }>;
    };
    expect(body.runs.length).toBe(1);
    expect(body.runs[0]!.spanId).toBe("r_detail");
    expect(body.runs[0]!.status).toBe("succeeded");
    expect(body.runs[0]!.endedAt).toBe(5000);
  });
});

describe("transition backward edge guard", () => {
  test("in_review→in_progress via /transition is rejected (must use review-decision)", async () => {
    const { issueSvc, app } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });
    issueSvc.applyTransition(issue.issueId, "planned");
    issueSvc.applyTransition(issue.issueId, "in_progress");
    issueSvc.applyTransition(issue.issueId, "in_review");

    const res = await app.handle(
      new Request(`http://localhost/api/issues/${issue.issueId}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "in_progress" }),
      }),
    );
    expect(res.status).toBe(409);
  });

  test("forward transition via /transition still works (in_progress→in_review)", async () => {
    const { issueSvc, app } = setup();
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Test" });
    issueSvc.applyTransition(issue.issueId, "planned");
    issueSvc.applyTransition(issue.issueId, "in_progress");

    const res = await app.handle(
      new Request(`http://localhost/api/issues/${issue.issueId}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "in_review" }),
      }),
    );
    expect(res.status).toBe(200);
  });
});
