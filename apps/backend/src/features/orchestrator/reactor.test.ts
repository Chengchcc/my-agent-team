import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import type { AgentRow } from "../agent/domain.js";
import type { AgentService } from "../agent/service.js";
import type { ColumnConfigService } from "../column-config/service.js";
import { sqliteIssueAdapter } from "../issue/adapter-sqlite.js";
import { createIssueService } from "../issue/service.js";
import { runEventsDbMigrations } from "../run/events-db-migrations.js";
import type { RunSupervisor } from "../run/supervisor.js";
import { RuntimeOpsStore } from "../runtime-ops/store.js";
import { createOrchestrator, OrchestratorAgentMissingError } from "./reactor.js";
import type { Transition } from "./transitions.js";

// ── Mock ColumnConfig ──────────────────────────────────────

/** Mirrors old TRANSITIONS behavior: planned→in_progress by planner,
 *  in_progress→in_review by developer, in_review→done by reviewer. */
function mockColumnConfigSvc(): ColumnConfigService {
  const transitions: Transition[] = [
    {
      from: "planned",
      to: "in_progress",
      agentId: "planner",
      promptTemplate: "Plan for {{title}}",
    },
    {
      from: "in_progress",
      to: "in_review",
      agentId: "developer",
      promptTemplate: "Work on {{title}}",
    },
    { from: "in_review", to: "done", agentId: "reviewer", promptTemplate: "Review {{title}}" },
  ];
  return {
    port: {} as ColumnConfigService["port"],
    listByProject: () => [],
    upsert: async () => {
      throw new Error("not implemented");
    },
    remove: () => {
      throw new Error("not implemented");
    },
    transitionsForProject: (_projectId: string) => transitions,
  };
}

function mockDeliverableSvc(
  _rows: Array<{
    kind: string;
    fields: Record<string, string>;
    ref?: string;
    createdAt: number;
  }> = [],
) {
  return {
    listByIssue(_issueId: string) {
      return _rows.map((r, i) => ({
        deliverableId: `d_${i}`,
        issueId: _issueId,
        fromStatus: "planned",
        kind: r.kind,
        fields: r.fields,
        ref: r.ref ?? null,
        runId: `run_00${i}`,
        idempotencyKey: null,
        createdAt: r.createdAt,
      }));
    },
  };
}

// ── Fakes ─────────────────────────────────────────────────

interface FakeSupervisor extends RunSupervisor {
  startedRuns: Array<{ runId: string; threadId: string; spec: Record<string, unknown> }>;
}

function fakeSupervisor(): FakeSupervisor {
  const startedRuns: Array<{ runId: string; threadId: string; spec: Record<string, unknown> }> = [];
  const self = {
    startedRuns,
    startMainRun: async (runId: string, threadId: string, spec: Record<string, unknown>) => {
      startedRuns.push({ runId, threadId, spec });
      return { runId, attemptId: `attempt-${runId}` };
    },
    onRunComplete: () => {},
  } as unknown as FakeSupervisor;
  return self;
}

function fakeAgentSvc(agents: Map<string, AgentRow>): AgentService {
  return {
    getById: async (id: string) => {
      const agent = agents.get(id);
      if (!agent) {
        const err = new Error(`Agent not found: ${id}`);
        (err as Error & { name: string }).name = "AgentNotFoundError";
        throw err;
      }
      return agent;
    },
    exists: async (id: string) => agents.has(id),
    create: async () => {
      throw new Error("not implemented");
    },
    list: async () => [],
    update: async () => {
      throw new Error("not implemented");
    },
    archive: async () => {
      throw new Error("not implemented");
    },
    hardDelete: async () => {
      throw new Error("not implemented");
    },
  } as unknown as AgentService;
}

function makeAgentRow(overrides?: Partial<AgentRow>): AgentRow {
  return {
    id: "test-agent",
    name: "test-agent",
    template: null,
    workspacePath: "/tmp/ws",
    modelProvider: "anthropic",
    modelName: "claude-sonnet-4-6",
    modelBaseUrl: null,
    permissionMode: "ask",
    maxSteps: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archivedAt: null,
    larkEnabled: false,
    larkAppId: null,
    larkProfileRef: null,
    larkBotDisplayName: null,
    ...overrides,
  };
}

async function buildSpec(
  agentId: string,
  threadId: string,
  input: string,
): Promise<Record<string, unknown>> {
  return {
    schemaVersion: "2",
    agentId,
    threadId,
    runId: crypto.randomUUID(),
    mode: "run",
    input,
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    permissionMode: "ask",
  };
}

// ── Setup ─────────────────────────────────────────────────

const agents = new Map<string, AgentRow>();
agents.set("planner", makeAgentRow({ id: "planner", name: "planner" }));
agents.set("developer", makeAgentRow({ id: "developer", name: "developer" }));
agents.set("reviewer", makeAgentRow({ id: "reviewer", name: "reviewer" }));

function makeOrchestrator(issueDb: Database, eventsDb: Database) {
  const issuePort = sqliteIssueAdapter(issueDb);
  const issueSvc = createIssueService({ port: issuePort, idGen: () => crypto.randomUUID() });
  const supervisor = fakeSupervisor();
  const opsStore = new RuntimeOpsStore(eventsDb);

  const orch = createOrchestrator({
    issueSvc,
    agentSvc: fakeAgentSvc(agents),
    supervisor: supervisor as unknown as RunSupervisor,
    opsStore,
    buildSpec,
    idGen: () => crypto.randomUUID(),
    columnConfigSvc: mockColumnConfigSvc(),
    deliverableSvc: mockDeliverableSvc(),
    now: () => 1000000,
  });

  return { orch, issueSvc, supervisor, opsStore };
}

// ── Tests ─────────────────────────────────────────────────

describe("Orchestrator reactor", () => {
  let issueDb: Database;
  let eventsDb: Database;

  beforeAll(() => {
    issueDb = openDb("/tmp/test-orchestrator-issue.db");
    eventsDb = new Database("/tmp/test-orchestrator-events.db");
    eventsDb.exec("PRAGMA journal_mode=WAL");
    runEventsDbMigrations(eventsDb);
  });

  afterAll(() => {
    issueDb.close();
    eventsDb.close();
  });

  test("startStep returns null for draft (no config → no auto-advance)", async () => {
    const { orch, issueSvc } = makeOrchestrator(issueDb, eventsDb);
    const issue = issueSvc.createIssue({
      projectId: "proj-1",
      title: "Draft Issue",
    });
    expect(issue.status).toBe("draft");

    // draft has no ColumnConfig → no transition → startStep returns null
    const result = await orch.startStep(issue);
    expect(result).toBeNull();
  });

  test("startStep creates run for planned status", async () => {
    const { orch, issueSvc, supervisor } = makeOrchestrator(issueDb, eventsDb);
    const issue = issueSvc.createIssue({
      projectId: "proj-2",
      title: "Test Issue",
    });
    // Move draft→planned (manual drag simulation)
    const planned = issueSvc.applyTransition(issue.issueId, "planned");
    expect(planned.status).toBe("planned");

    const result = await orch.startStep(planned);
    expect(result).not.toBeNull();
    expect(result!.runId).toBeTruthy();

    expect(supervisor.startedRuns.length).toBe(1);
    expect(supervisor.startedRuns[0]!.spec.agentId).toBe("planner");
    expect(supervisor.startedRuns[0]!.threadId).toBe(planned.threadId);
  });

  test("startStep returns null for done status (terminal)", async () => {
    const { orch, issueSvc } = makeOrchestrator(issueDb, eventsDb);
    const issue = issueSvc.createIssue({
      projectId: "proj-3",
      title: "Done Issue",
    });
    issueSvc.applyTransition(issue.issueId, "planned");
    issueSvc.applyTransition(issue.issueId, "in_progress");
    issueSvc.applyTransition(issue.issueId, "in_review");
    const done = issueSvc.applyTransition(issue.issueId, "done");
    expect(done.status).toBe("done");

    const result = await orch.startStep(done);
    expect(result).toBeNull();
  });

  test("startStep throws OrchestratorAgentMissingError when agent missing from config", async () => {
    // Use a custom agents map without the required agents
    const missingAgents = new Map<string, AgentRow>();
    const issuePort = sqliteIssueAdapter(issueDb);
    const issueSvc = createIssueService({ port: issuePort, idGen: () => crypto.randomUUID() });
    const supervisor = fakeSupervisor();
    const opsStore = new RuntimeOpsStore(eventsDb);

    const orch = createOrchestrator({
      issueSvc,
      agentSvc: fakeAgentSvc(missingAgents), // empty — no agents
      supervisor: supervisor as unknown as RunSupervisor,
      opsStore,
      buildSpec,
      idGen: () => crypto.randomUUID(),
      columnConfigSvc: mockColumnConfigSvc(), // still returns config with agentIds
      deliverableSvc: mockDeliverableSvc(),
    });

    const issue = issueSvc.createIssue({
      projectId: "proj-4",
      title: "Missing Agent Issue",
    });
    const planned = issueSvc.applyTransition(issue.issueId, "planned");

    // mockColumnConfigSvc returns "planner" as agentId, but agents map is empty
    await expect(orch.startStep(planned)).rejects.toBeInstanceOf(OrchestratorAgentMissingError);
  });

  test("onRunComplete: succeeded run advances status and starts next step", async () => {
    const { orch, issueSvc, supervisor } = makeOrchestrator(issueDb, eventsDb);

    const issue = issueSvc.createIssue({
      projectId: "proj-5",
      title: "Lifecycle Issue",
    });
    const planned = issueSvc.applyTransition(issue.issueId, "planned");
    const step1 = await orch.startStep(planned);
    expect(step1).not.toBeNull();
    const startCount = supervisor.startedRuns.length;

    await orch.onRunComplete(planned.threadId, step1!.runId, "succeeded", "main");

    const updated = issueSvc.port.getIssue(issue.issueId);
    expect(updated!.status).toBe("in_progress");
    // Should have started a second run (developer)
    expect(supervisor.startedRuns.length).toBe(startCount + 1);
    expect(supervisor.startedRuns[startCount]!.spec.agentId).toBe("developer");
  });

  test("onRunComplete: non-succeeded run does not advance", async () => {
    const { orch, issueSvc, supervisor } = makeOrchestrator(issueDb, eventsDb);

    const issue = issueSvc.createIssue({
      projectId: "proj-6",
      title: "Failed Run Issue",
    });
    const planned = issueSvc.applyTransition(issue.issueId, "planned");
    const step1 = await orch.startStep(planned);
    const startCount = supervisor.startedRuns.length;

    await orch.onRunComplete(planned.threadId, step1!.runId, "error", "main");

    const updated = issueSvc.port.getIssue(issue.issueId);
    expect(updated!.status).toBe("planned"); // unchanged
    // No new runs
    expect(supervisor.startedRuns.length).toBe(startCount);
  });

  test("onRunComplete: ignores conversation-driven runs (no issueId in run_origin)", async () => {
    const { orch, supervisor } = makeOrchestrator(issueDb, eventsDb);

    const startCount = supervisor.startedRuns.length;
    await orch.onRunComplete("some-thread", "non-issue-run", "succeeded", "main");

    // Nothing should have happened
    expect(supervisor.startedRuns.length).toBe(startCount);
  });

  test("onRunComplete: repeated delivery is idempotent (CAS)", async () => {
    const { orch, issueSvc, supervisor } = makeOrchestrator(issueDb, eventsDb);

    const issue = issueSvc.createIssue({
      projectId: "proj-7",
      title: "Idempotent Issue",
    });
    const planned = issueSvc.applyTransition(issue.issueId, "planned");
    const step1 = await orch.startStep(planned);

    // First delivery — advances to in_progress, starts developer run
    await orch.onRunComplete(planned.threadId, step1!.runId, "succeeded", "main");
    const after1 = issueSvc.port.getIssue(issue.issueId);
    expect(after1!.status).toBe("in_progress");
    const count1 = supervisor.startedRuns.length;

    // Second delivery of same run — should NOT advance again
    await orch.onRunComplete(planned.threadId, step1!.runId, "succeeded", "main");
    const after2 = issueSvc.port.getIssue(issue.issueId);
    expect(after2!.status).toBe("in_progress"); // still in_progress
    expect(supervisor.startedRuns.length).toBe(count1); // no new runs
  });
});
