import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { createColumnConfigService, sqliteColumnConfigAdapter } from "../column-config/index.js";
import { createDeliverableService, sqliteDeliverableAdapter } from "../deliverable/index.js";
import { createIssueService, sqliteIssueAdapter } from "../issue/index.js";
import { RuntimeOpsStore } from "../runtime-ops/store.js";
import { runEventsDbMigrations } from "../span/events-db-migrations.js";

function setupE2E() {
  // backend.db tables (issue, column_config, deliverable, ...) from the canonical
  // drizzle migrations so the e2e DB never drifts from production schema.
  const db = openDb(":memory:");

  const eventsDb = new Database(":memory:");
  runEventsDbMigrations(eventsDb);

  const opsStore = new RuntimeOpsStore(eventsDb);

  let idCounter = 0;
  const idGen = () => `e2e_${String(++idCounter).padStart(3, "0")}`;
  const now = () => 1000 + idCounter;

  const issueSvc = createIssueService({
    port: sqliteIssueAdapter(db),
    idGen,
    now,
  });

  const deliverableSvc = createDeliverableService({
    port: sqliteDeliverableAdapter(db),
    idGen,
    now,
  });

  const columnConfigPort = sqliteColumnConfigAdapter(db);
  columnConfigPort.upsert({
    configId: "cc_planned",
    projectId: "p1",
    status: "planned",
    agentId: "dev",
    promptTemplate: "Plan: {{title}}. Feedback: {{deliverables.rework_feedback.fields.note}}",
    now: 1000,
  });
  columnConfigPort.upsert({
    configId: "cc_in_progress",
    projectId: "p1",
    status: "in_progress",
    agentId: "dev",
    promptTemplate: "Dev: {{title}}. Feedback: {{deliverables.rework_feedback.fields.note}}",
    now: 1000,
  });
  columnConfigPort.upsert({
    configId: "cc_in_review",
    projectId: "p1",
    status: "in_review",
    agentId: "rev",
    promptTemplate: "Review: {{title}}",
    now: 1000,
  });

  const columnConfigSvc = createColumnConfigService({
    port: columnConfigPort,
    idGen,
    agentExists: async () => true,
  });

  return {
    db,
    eventsDb,
    opsStore,
    issueSvc,
    deliverableSvc,
    columnConfigSvc,
    idGen,
  };
}

describe("e2e issue lifecycle with timeline", () => {
  test("full lifecycle: create → start → run → review → reject → rework → timeline complete", () => {
    const { issueSvc, opsStore, deliverableSvc, columnConfigSvc } = setupE2E();

    // 1. Create issue
    const issue = issueSvc.createIssue({ projectId: "p1", title: "Add login page" });
    expect(issue.status).toBe("draft");
    opsStore.appendIssueEvent({
      issueId: issue.issueId,
      kind: "created",
      payload: { projectId: issue.projectId, title: issue.title },
    });

    // 2. Manually start (draft → planned)
    const started = issueSvc.applyTransition(issue.issueId, "planned");
    expect(started.status).toBe("planned");
    opsStore.appendIssueEvent({
      issueId: issue.issueId,
      kind: "started",
      payload: { from: "draft", to: "planned" },
    });

    // 3. Verify transitionsForProject produces planned→in_progress
    const table = columnConfigSvc.transitionsForProject("p1");
    const plannedT = table.find((t) => t.from === "planned");
    expect(plannedT).toBeDefined();

    // 4. Simulate developer run starting
    opsStore.insertSpanOrigin({
      spanId: "run_dev1",
      issueId: issue.issueId,
      conversationId: "",
      sourceLedgerSeq: 0,
      agentMemberId: "dev",
      surface: "orchestrator",
      traceId: "",
      traceparent: "",
      idempotencyKey: "run_dev1",
      originKind: "orchestrator",
      fromStatus: "planned",
      createdAt: 2000,
    });
    opsStore.appendIssueEvent({
      issueId: issue.issueId,
      kind: "run.started",
      payload: { spanId: "run_dev1", fromStatus: "planned", agentId: "dev" },
    });

    // 5. Auto-advance: planned → in_progress (by reactor)
    const inProgress = issueSvc.applyTransition(issue.issueId, "in_progress");
    expect(inProgress.status).toBe("in_progress");
    opsStore.appendIssueEvent({
      issueId: issue.issueId,
      kind: "status.advanced",
      payload: { from: "planned", to: "in_progress", by: "reactor" },
    });

    // 6. Submit deliverable from developer
    const d = deliverableSvc.submit({
      issueId: issue.issueId,
      fromStatus: "in_progress",
      kind: "mr",
      fields: { url: "https://git.example.com/mr/42" },
      spanId: "run_dev1",
    });
    opsStore.appendIssueEvent({
      issueId: issue.issueId,
      kind: "deliverable.submitted",
      payload: {
        kind: "mr",
        deliverableId: d.row.deliverableId,
        spanId: "run_dev1",
        ref: null,
      },
    });

    // 7. Auto-advance: in_progress → in_review
    const inReview = issueSvc.applyTransition(issue.issueId, "in_review");
    expect(inReview.status).toBe("in_review");
    opsStore.appendIssueEvent({
      issueId: issue.issueId,
      kind: "status.advanced",
      payload: { from: "in_progress", to: "in_review", by: "reactor" },
    });

    // 8. Human rejects with feedback
    const rejected = issueSvc.applyTransition(issue.issueId, "in_progress");
    expect(rejected.status).toBe("in_progress");
    opsStore.appendIssueEvent({
      issueId: issue.issueId,
      kind: "human.decided",
      payload: { decision: "reject", note: "Add unit tests" },
    });
    opsStore.appendIssueEvent({
      issueId: issue.issueId,
      kind: "status.advanced",
      payload: { from: "in_review", to: "in_progress", by: "rework" },
    });

    const fb = deliverableSvc.submit({
      issueId: issue.issueId,
      fromStatus: "in_review",
      kind: "rework_feedback",
      fields: { note: "Add unit tests" },
    });
    opsStore.appendIssueEvent({
      issueId: issue.issueId,
      kind: "deliverable.submitted",
      payload: {
        kind: "rework_feedback",
        deliverableId: fb.row.deliverableId,
        spanId: null,
        ref: null,
      },
    });

    // 9. Verify rework feedback is in deliverables
    const deliverables = deliverableSvc.listByIssue(issue.issueId);
    const feedback = deliverables.find((d) => d.kind === "rework_feedback");
    expect(feedback).toBeDefined();
    expect(feedback!.fields.note).toBe("Add unit tests");

    // 10. Verify complete timeline event chain
    const timeline = opsStore.getIssueEvents(issue.issueId);
    expect(timeline.length).toBe(9);

    const kinds = timeline.map((e) => e.kind);
    expect(kinds).toEqual([
      "created",
      "started",
      "run.started",
      "status.advanced",
      "deliverable.submitted",
      "status.advanced",
      "human.decided",
      "status.advanced",
      "deliverable.submitted",
    ]);

    // 11. Verify reverse lookup: issue → runs
    const origins = opsStore.getSpanOriginsByIssueId(issue.issueId);
    expect(origins.length).toBe(1);
    expect(origins[0]!.spanId).toBe("run_dev1");
    expect(origins[0]!.fromStatus).toBe("planned");
  });
});
