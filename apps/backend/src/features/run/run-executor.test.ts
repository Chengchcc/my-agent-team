import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { executeAgentRun } from "./run-executor.js";
import { RunSupervisor } from "./supervisor.js";

// ─── Helpers ──────────────────────────────────────────────

function makeDB(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  return db;
}

function mockAgentSvc() {
  return {
    getById: async () => ({
      modelName: "claude",
      modelProvider: "anthropic",
      modelBaseUrl: null,
      permissionMode: "ask",
      maxSteps: null,
    }),
    exists: async () => true,
  };
}

function mockOpsStore() {
  return {
    insertRunOrigin: () => {},
    getRunOrigin: () => null,
    appendRunEvent: () => {},
  };
}

function mockConfig() {
  return {
    dataDir: "/tmp",
    anthropicApiKey: "test",
    port: 0,
    host: "",
    authToken: "",
    reaperIntervalMs: 0,
    heartbeatTimeoutMs: 30000,
    heartbeatIntervalMs: 5000,
    stepStallTimeoutMs: 120_000,
    cancelGraceMs: 5000,
    maxConcurrentRuns: 8,
    shutdownTimeoutMs: 5000,
    workspaceRoot: "/tmp",
    templateDir: "/tmp",
  };
}

function makeSupervisor(db: Database): RunSupervisor {
  return new RunSupervisor({
    config: mockConfig(),
    eventLog: {
      append: async () => {
        /* no-op */
      },
      read: async () => [] as any[],
      subscribe: () => ({}) as any,
    } as any,
    opsStore: mockOpsStore() as any,
    tracer: {
      inject: () => ({ traceId: "", traceparent: "" }),
      startSpan: () => ({}),
      currentTrace: () => null,
      link: () => {},
    } as any,
    db,
    onReap: () => {},
  });
}

async function waitForFinalize(s: RunSupervisor, runId: string, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (s.getActive().has(runId) && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ─── Tests ────────────────────────────────────────────────

describe("executeAgentRun completion signal", () => {
  let db: Database;
  let supervisor: RunSupervisor;

  beforeAll(() => {
    db = makeDB();
    supervisor = makeSupervisor(db);
  });
  afterAll(() => {
    db.close();
  });

  async function runAndWait(opts: Record<string, unknown>) {
    const calls: string[] = [];
    supervisor.onRunComplete((_t, _r, status) => {
      calls.push(status);
    });
    const { runId } = await executeAgentRun({
      runId: `${opts.prefix}-${Date.now()}`,
      threadId: opts.threadId as string,
      agentId: opts.agentId as string,
      input: (opts.input as string) ?? "hi",
      config: mockConfig() as any,
      agentSvc: mockAgentSvc() as any,
      supervisor,
      opsStore: mockOpsStore() as any,
      surface: opts.surface as string | undefined,
      senderName: opts.senderName as string | undefined,
      originKind: opts.originKind as any,
      origin: (opts.origin || {}) as Record<string, unknown>,
    });
    await waitForFinalize(supervisor, runId);
    return { runId, calls };
  }

  test("conversation: completes, clears active, fires onRunComplete", async () => {
    const { calls } = await runAndWait({
      prefix: "conv",
      threadId: "conv:agent-test",
      agentId: "agent-test",
      originKind: "manual",
    });
    expect(calls).toContain("succeeded");
  });

  test("orchestrator: fires onRunComplete", async () => {
    const { calls } = await runAndWait({
      prefix: "orch",
      threadId: "issue:agent-orch",
      agentId: "agent-orch",
      surface: "orchestrator",
      senderName: "orchestrator",
      originKind: "orchestrator",
      origin: { issueId: "i1", fromStatus: "planned" },
    });
    expect(calls).toContain("succeeded");
  });

  test("cron: fires onRunComplete", async () => {
    const { calls } = await runAndWait({
      prefix: "cron",
      threadId: "cron:owner",
      agentId: "agent-cron",
      surface: "cron",
      senderName: "cron",
      originKind: "cron",
    });
    expect(calls).toContain("succeeded");
  });
});
