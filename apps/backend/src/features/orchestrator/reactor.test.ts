import { openDb } from "../../infra/sqlite/db.js";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  fakeAgentSvc,
  fakeColumnConfigSvc,
  fakeDeliverableSvc,
  fakeProjectSvc,
  makeAgentRow,
  recordingSupervisor,
  TID,
  testDB,
  testMainDB,
} from "../../../test-helpers/mock-deps.js";
import { sqliteIssueAdapter } from "../issue/adapter-sqlite.js";
import { createIssueService } from "../issue/service.js";
import { RuntimeOpsStore } from "../runtime-ops/store.js";
import { createOrchestrator, OrchestratorAgentMissingError } from "./reactor.js";

const DEFAULT_AGENTS = new Map([
  ["planner", makeAgentRow({ id: "planner", name: "planner" })],
  ["developer", makeAgentRow({ id: "developer", name: "developer" })],
  ["reviewer", makeAgentRow({ id: "reviewer", name: "reviewer" })],
]);

function makeOrchestrator(
  issueDb: ReturnType<typeof testMainDB>,
  eventsDb: ReturnType<typeof testDB>,
) {
  const issuePort = sqliteIssueAdapter(issueDb);
  const issueSvc = createIssueService({ port: issuePort, idGen: () => crypto.randomUUID() });
  const supervisor = recordingSupervisor();
  const opsStore = new RuntimeOpsStore(eventsDb);

  const orch = createOrchestrator({
    config: { dataDir: "/tmp", anthropicApiKey: "test" } as any,
    issueSvc,
    agentSvc: fakeAgentSvc(DEFAULT_AGENTS),
    supervisor: supervisor as any,
    opsStore,
    idGen: () => crypto.randomUUID(),
    columnConfigSvc: fakeColumnConfigSvc() as any,
    deliverableSvc: fakeDeliverableSvc(),
    projectSvc: fakeProjectSvc(),
    now: () => 1000000,
  });

  return { orch, issueSvc, supervisor, opsStore };
}

describe("Orchestrator reactor", () => {
  let issueDb: ReturnType<typeof testMainDB>;
  let eventsDb: ReturnType<typeof testDB>;

  beforeAll(() => {
    issueDb = testMainDB();
    eventsDb = testDB();
  });

  afterAll(() => {
    issueDb.close();
    eventsDb.close();
  });

  test("startStep returns null for draft (no config → no auto-advance)", async () => {
    const { orch, issueSvc } = makeOrchestrator(issueDb, eventsDb);
    const issue = issueSvc.createIssue({ projectId: "proj-1", title: "Draft Issue" });
    expect(issue.status).toBe("draft");
    const result = await orch.startStep(issue);
    expect(result).toBeNull();
  });

  test("startStep creates run for planned status", async () => {
    const { orch, issueSvc, supervisor } = makeOrchestrator(issueDb, eventsDb);
    const issue = issueSvc.createIssue({ projectId: "proj-2", title: "Test Issue" });
    const planned = issueSvc.applyTransition(issue.issueId, "planned");
    expect(planned.status).toBe("planned");

    const result = await orch.startStep(planned);
    expect(result).not.toBeNull();
    expect(result!.spanId).toBeTruthy();
    expect(supervisor.startedRuns.length).toBe(1);
    expect(supervisor.startedRuns[0]!.spec.agentId).toBe("planner");
    expect(supervisor.startedRuns[0]!.sessionId).toBe(TID.issueSession(planned.issueId, "planner"));
  });

  test("startStep returns null for done status (terminal)", async () => {
    const { orch, issueSvc } = makeOrchestrator(issueDb, eventsDb);
    const issue = issueSvc.createIssue({ projectId: "proj-3", title: "Done Issue" });
    issueSvc.applyTransition(issue.issueId, "planned");
    issueSvc.applyTransition(issue.issueId, "in_progress");
    issueSvc.applyTransition(issue.issueId, "in_review");
    const done = issueSvc.applyTransition(issue.issueId, "done");
    expect(done.status).toBe("done");
    const result = await orch.startStep(done);
    expect(result).toBeNull();
  });

  test("startStep throws OrchestratorAgentMissingError when agent missing from config", async () => {
    const issuePort = sqliteIssueAdapter(issueDb);
    const issueSvc = createIssueService({ port: issuePort, idGen: () => crypto.randomUUID() });
    const supervisor = recordingSupervisor();
    const opsStore = new RuntimeOpsStore(eventsDb);

    const orch = createOrchestrator({
      issueSvc,
      agentSvc: fakeAgentSvc(new Map()),
      supervisor: supervisor as any,
      opsStore,
      config: { dataDir: "/tmp", anthropicApiKey: "test" } as any,
      idGen: () => crypto.randomUUID(),
      columnConfigSvc: fakeColumnConfigSvc() as any,
      deliverableSvc: fakeDeliverableSvc(),
      projectSvc: fakeProjectSvc(),
    });

    const issue = issueSvc.createIssue({ projectId: "proj-4", title: "Missing Agent Issue" });
    const planned = issueSvc.applyTransition(issue.issueId, "planned");
    await expect(orch.startStep(planned)).rejects.toBeInstanceOf(OrchestratorAgentMissingError);
  });

  test("onRunComplete: succeeded run advances status and starts next step", async () => {
    const { orch, issueSvc, supervisor } = makeOrchestrator(issueDb, eventsDb);
    const issue = issueSvc.createIssue({ projectId: "proj-5", title: "Lifecycle Issue" });
    const planned = issueSvc.applyTransition(issue.issueId, "planned");
    const step1 = await orch.startStep(planned);
    expect(step1).not.toBeNull();
    const startCount = supervisor.startedRuns.length;

    await orch.onRunComplete(planned.sessionId, step1!.spanId, "succeeded", "main");

    const updated = issueSvc.port.getIssue(issue.issueId);
    expect(updated!.status).toBe("in_progress");
    expect(supervisor.startedRuns.length).toBe(startCount + 1);
    expect(supervisor.startedRuns[startCount]!.spec.agentId).toBe("developer");
  });

  test("onRunComplete: non-succeeded run does not advance", async () => {
    const { orch, issueSvc, supervisor } = makeOrchestrator(issueDb, eventsDb);
    const issue = issueSvc.createIssue({ projectId: "proj-6", title: "Failed Run Issue" });
    const planned = issueSvc.applyTransition(issue.issueId, "planned");
    const step1 = await orch.startStep(planned);
    const startCount = supervisor.startedRuns.length;
    await orch.onRunComplete(planned.sessionId, step1!.spanId, "error", "main");
    const updated = issueSvc.port.getIssue(issue.issueId);
    expect(updated!.status).toBe("planned");
    expect(supervisor.startedRuns.length).toBe(startCount);
  });

  test("onRunComplete: ignores conversation-driven runs (no issueId in run_origin)", async () => {
    const { orch, supervisor } = makeOrchestrator(issueDb, eventsDb);
    const startCount = supervisor.startedRuns.length;
    await orch.onRunComplete("some-thread", "non-issue-run", "succeeded", "main");
    expect(supervisor.startedRuns.length).toBe(startCount);
  });

  test("onRunComplete: repeated delivery is idempotent (CAS)", async () => {
    const { orch, issueSvc, supervisor } = makeOrchestrator(issueDb, eventsDb);
    const issue = issueSvc.createIssue({ projectId: "proj-7", title: "Idempotent Issue" });
    const planned = issueSvc.applyTransition(issue.issueId, "planned");
    const step1 = await orch.startStep(planned);
    await orch.onRunComplete(planned.sessionId, step1!.spanId, "succeeded", "main");
    const after1 = issueSvc.port.getIssue(issue.issueId);
    expect(after1!.status).toBe("in_progress");
    const count1 = supervisor.startedRuns.length;
    await orch.onRunComplete(planned.sessionId, step1!.spanId, "succeeded", "main");
    const after2 = issueSvc.port.getIssue(issue.issueId);
    expect(after2!.status).toBe("in_progress");
    expect(supervisor.startedRuns.length).toBe(count1);
  });

  test("onRunComplete: succeeded reviewer run does NOT auto-advance from in_review (gate)", async () => {
    const { orch, issueSvc, supervisor } = makeOrchestrator(issueDb, eventsDb);
    const issue = issueSvc.createIssue({ projectId: "proj-gate", title: "Gate Issue" });
    issueSvc.applyTransition(issue.issueId, "planned");
    issueSvc.applyTransition(issue.issueId, "in_progress");
    const review = issueSvc.applyTransition(issue.issueId, "in_review");
    expect(review.status).toBe("in_review");

    const reviewRunId = "run-review-1";
    const opsStore = new RuntimeOpsStore(eventsDb);
    opsStore.insertSpanOrigin({
      spanId: reviewRunId,
      issueId: issue.issueId,
      conversationId: "",
      sourceLedgerSeq: 0,
      agentMemberId: "reviewer",
      surface: "orchestrator",
      traceId: "",
      traceparent: "",
      idempotencyKey: reviewRunId,
      originKind: "orchestrator",
      fromStatus: "in_review",
      createdAt: 1000000,
    });

    const startCount = supervisor.startedRuns.length;
    await orch.onRunComplete(review.sessionId, reviewRunId, "succeeded", "main");
    const updated = issueSvc.port.getIssue(issue.issueId);
    expect(updated!.status).toBe("in_review");
    expect(supervisor.startedRuns.length).toBe(startCount);
  });

  test("onRunComplete: fromStatus guard uses origin.fromStatus (not key parsing)", async () => {
    const { orch, issueSvc, supervisor } = makeOrchestrator(issueDb, eventsDb);
    const issue = issueSvc.createIssue({ projectId: "proj-guard", title: "Guard Issue" });
    const planned = issueSvc.applyTransition(issue.issueId, "planned");
    const step1 = await orch.startStep(planned);
    expect(step1).not.toBeNull();
    await orch.onRunComplete(planned.sessionId, step1!.spanId, "succeeded", "main");
    const after1 = issueSvc.port.getIssue(issue.issueId);
    expect(after1!.status).toBe("in_progress");
    const count1 = supervisor.startedRuns.length;
    await orch.onRunComplete(planned.sessionId, step1!.spanId, "succeeded", "main");
    const after2 = issueSvc.port.getIssue(issue.issueId);
    expect(after2!.status).toBe("in_progress");
    expect(supervisor.startedRuns.length).toBe(count1);
  });

  test("onRunComplete: rework round-trip — second in_progress run writes origin without collision", async () => {
    const { orch, issueSvc, supervisor } = makeOrchestrator(issueDb, eventsDb);
    const issue = issueSvc.createIssue({ projectId: "proj-rework", title: "Rework Issue" });
    const planned = issueSvc.applyTransition(issue.issueId, "planned");
    const run1 = await orch.startStep(planned);
    expect(run1).not.toBeNull();
    const opsStore = new RuntimeOpsStore(eventsDb);
    const origin1 = opsStore.getSpanOrigin(run1!.spanId);
    expect(origin1).not.toBeNull();
    expect(origin1!.fromStatus).toBe("planned");
    expect(origin1!.idempotencyKey).toBe(run1!.spanId);

    await orch.onRunComplete(planned.sessionId, run1!.spanId, "succeeded", "main");
    let current = issueSvc.port.getIssue(issue.issueId);
    expect(current!.status).toBe("in_progress");

    const runDev = supervisor.startedRuns[supervisor.startedRuns.length - 1]!;
    opsStore.insertSpanOrigin({
      spanId: runDev.spanId,
      issueId: issue.issueId,
      conversationId: "",
      sourceLedgerSeq: 0,
      agentMemberId: "developer",
      surface: "orchestrator",
      traceId: "",
      traceparent: "",
      idempotencyKey: runDev.spanId,
      originKind: "orchestrator",
      fromStatus: "in_progress",
      createdAt: 1000000,
    });
    await orch.onRunComplete(current!.sessionId, runDev.spanId, "succeeded", "main");
    current = issueSvc.port.getIssue(issue.issueId);
    expect(current!.status).toBe("in_review");

    const reworked = issueSvc.applyTransition(issue.issueId, "in_progress");
    expect(reworked.status).toBe("in_progress");
    const run2 = await orch.startStep(reworked);
    expect(run2).not.toBeNull();
    const origin2 = opsStore.getSpanOrigin(run2!.spanId);
    expect(origin2).not.toBeNull();
    expect(origin2!.issueId).toBe(issue.issueId);
    expect(origin2!.fromStatus).toBe("in_progress");
    expect(origin2!.idempotencyKey).toBe(run2!.spanId);
    expect(origin2!.idempotencyKey).not.toBe(runDev.spanId);
  });

  test("startStep emits run.started event", async () => {
    const { orch, issueSvc, opsStore } = makeOrchestrator(issueDb, eventsDb);
    const issue = issueSvc.createIssue({ projectId: "proj-emit", title: "Emit Test" });
    const planned = issueSvc.applyTransition(issue.issueId, "planned");
    await orch.startStep(planned);
    const events = opsStore.getIssueEvents(issue.issueId);
    const started = events.find((e) => e.kind === "run.started");
    expect(started).toBeDefined();
    expect(started!.payload.fromStatus).toBe("planned");
    expect(typeof started!.payload.spanId).toBe("string");
    expect(started!.payload.agentId).toBe("planner");
  });

  test("run.ended emitted on completion", async () => {
    const { orch, issueSvc, opsStore } = makeOrchestrator(issueDb, eventsDb);
    const issue = issueSvc.createIssue({ projectId: "proj-emit2", title: "Ended Test" });
    const planned = issueSvc.applyTransition(issue.issueId, "planned");
    const step = await orch.startStep(planned);
    expect(step).not.toBeNull();
    opsStore.insertSpanOrigin({
      spanId: step!.spanId,
      issueId: issue.issueId,
      conversationId: "",
      sourceLedgerSeq: 0,
      agentMemberId: "planner",
      surface: "orchestrator",
      traceId: "",
      traceparent: "",
      idempotencyKey: step!.spanId,
      originKind: "orchestrator",
      fromStatus: "planned",
      createdAt: Date.now(),
    });
    await orch.onRunComplete(planned.sessionId, step!.spanId, "succeeded", "main");
    const events = opsStore.getIssueEvents(issue.issueId);
    const ended = events.find((e) => e.kind === "run.ended");
    expect(ended).toBeDefined();
    expect(ended!.payload.spanId).toBe(step!.spanId);
    expect(ended!.payload.status).toBe("succeeded");
  });

  test("status.advanced emitted with by:'reactor' on auto-advance", async () => {
    const { orch, issueSvc, opsStore } = makeOrchestrator(issueDb, eventsDb);
    const issue = issueSvc.createIssue({ projectId: "proj-emit3", title: "Advance Test" });
    const planned = issueSvc.applyTransition(issue.issueId, "planned");
    const step = await orch.startStep(planned);
    expect(step).not.toBeNull();
    opsStore.insertSpanOrigin({
      spanId: step!.spanId,
      issueId: issue.issueId,
      conversationId: "",
      sourceLedgerSeq: 0,
      agentMemberId: "planner",
      surface: "orchestrator",
      traceId: "",
      traceparent: "",
      idempotencyKey: step!.spanId,
      originKind: "orchestrator",
      fromStatus: "planned",
      createdAt: Date.now(),
    });
    await orch.onRunComplete(planned.sessionId, step!.spanId, "succeeded", "main");
    const events = opsStore.getIssueEvents(issue.issueId);
    const adv = events.find((e) => e.kind === "status.advanced");
    expect(adv).toBeDefined();
    expect(adv!.payload.by).toBe("reactor");
    expect(adv!.payload.from).toBe("planned");
    expect(adv!.payload.to).toBe("in_progress");
  });

  test("emitIssueEvent failure does not block startStep", async () => {
    const { orch, issueSvc, opsStore } = makeOrchestrator(issueDb, eventsDb);
    const issue = issueSvc.createIssue({ projectId: "proj-emit4", title: "Swallow Test" });
    const planned = issueSvc.applyTransition(issue.issueId, "planned");
    const result = await orch.startStep(planned);
    expect(result).not.toBeNull();
    expect(result!.spanId).toBeString();
    const events = opsStore.getIssueEvents(issue.issueId);
    expect(events.some((e) => e.kind === "run.started")).toBe(true);
  });
});
