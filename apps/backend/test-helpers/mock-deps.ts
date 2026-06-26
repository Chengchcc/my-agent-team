/* eslint-disable @typescript-eslint/no-explicit-any */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRow, CreateAgentInput, UpdateAgentInput } from "../src/features/agent/domain.js";
import type { AgentService } from "../src/features/agent/service.js";
import type { ColumnConfigService } from "../src/features/column-config/service.js";
import type { DeliverableRow } from "../src/features/deliverable/domain.js";
import type { OrchestratorDeps } from "../src/features/orchestrator/reactor.js";
import type { Transition } from "../src/features/orchestrator/transitions.js";
import { RunSupervisor } from "../src/features/run/supervisor.js";

// ═══════════════════════════════════════════════════════════════
// Test directory & db
// ═══════════════════════════════════════════════════════════════

/** Create a shared test directory for the whole test suite. */
const TEST_ROOT = join(tmpdir(), `agent-team-test-${Date.now()}`);
mkdirSync(TEST_ROOT, { recursive: true });

export function testDir(...parts: string[]): string {
  const p = join(TEST_ROOT, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
}

export function testDB(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  return db;
}

// ═══════════════════════════════════════════════════════════════
// Mock config
// ═══════════════════════════════════════════════════════════════

export function mockConfig() {
  const dir = testDir();
  return {
    dataDir: dir,
    workspaceRoot: join(dir, "workspaces"),
    templateDir: join(dir, "templates"),
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
  };
}

// ═══════════════════════════════════════════════════════════════
// Mock services (B — data stubs)
// ═══════════════════════════════════════════════════════════════

export function mockOpsStore() {
  return {
    insertRunOrigin: () => {},
    getRunOrigin: () => null,
    appendRunEvent: () => {},
  };
}

export function mockAgentSvc() {
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

export function mockSupervisor(db: Database): RunSupervisor {
  return new RunSupervisor({
    config: mockConfig(),
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

// ═══════════════════════════════════════════════════════════════
// TID — centralized test ID generation
// ═══════════════════════════════════════════════════════════════

export const TID = {
  conversation: (s = "c1") => s,
  /** sessionId formula: context:agent */
  session: (ctx = "c1", agent = "a1") => `${ctx}:${agent}`,
  /** Phase 5 unified format (same shape as session, semantically distinct) */
  issueSession: (issue: string, agent: string) => `${issue}:${agent}`,
  run: (s = "r1") => s,
};

// ═══════════════════════════════════════════════════════════════
// RecordingSupervisor (A — recording spy)
// ═══════════════════════════════════════════════════════════════

export interface RecordingSupervisor {
  startedRuns: Array<{ runId: string; threadId: string; spec: Record<string, unknown> }>;
  getActive(): ReadonlyMap<string, { abortController: AbortController }>;
  startMainRun(
    runId: string,
    threadId: string,
    spec: Record<string, unknown>,
  ): Promise<{ runId: string; attemptId: string }>;
  cancel(runId: string): boolean;
  onRunComplete(
    fn: (threadId: string, runId: string, status: string, kind: string) => void | Promise<void>,
  ): void;
  notifyRunComplete(runId: string, status: string): Promise<void>;
  getDb(): { query: (_sql: string) => { get: () => unknown } };
}

export function recordingSupervisor(): RecordingSupervisor {
  const startedRuns: Array<{
    runId: string;
    threadId: string;
    spec: Record<string, unknown>;
  }> = [];
  const active = new Map<string, { abortController: AbortController }>();
  const completeHandlers: Array<
    (threadId: string, runId: string, status: string, kind: string) => void | Promise<void>
  > = [];

  return {
    startedRuns,
    getActive: () => active as ReadonlyMap<string, { abortController: AbortController }>,
    startMainRun: async (runId: string, threadId: string, spec: Record<string, unknown>) => {
      startedRuns.push({ runId, threadId, spec });
      active.set(runId, { abortController: new AbortController() });
      return { runId, attemptId: `attempt-${runId}` };
    },
    cancel: (runId: string) => {
      active.get(runId)?.abortController.abort();
      return true;
    },
    onRunComplete: (
      fn: (threadId: string, runId: string, status: string, kind: string) => void | Promise<void>,
    ) => {
      completeHandlers.push(fn);
    },
    notifyRunComplete: async (runId: string, status: string) => {
      for (const h of completeHandlers) {
        await h("", runId, status, "main");
      }
    },
    getDb: () => ({ query: () => ({ get: () => null }) }),
  };
}

// ═══════════════════════════════════════════════════════════════
// recordingRunStatus (A — recording spy for onRunStatus)
// ═══════════════════════════════════════════════════════════════

export function recordingRunStatus(): {
  calls: Array<{ runId: string; phase: string; detail?: string }>;
  onRunStatus: (s: { runId: string; phase: string; detail?: string; updatedAt: number }) => void;
} {
  const calls: Array<{ runId: string; phase: string; detail?: string }> = [];
  return {
    calls,
    onRunStatus: (s) => {
      calls.push({ runId: s.runId, phase: s.phase, detail: s.detail });
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// fakeAgentSvc (B — data stub for AgentService)
// ═══════════════════════════════════════════════════════════════

export function makeAgentRow(overrides?: Partial<AgentRow>): AgentRow {
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

export function fakeAgentSvc(agents: Map<string, AgentRow> = new Map()): AgentService {
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
    create: async (_input: CreateAgentInput) => {
      throw new Error("fakeAgentSvc.create not implemented — inject agents via Map instead");
    },
    list: async (_includeArchived?: boolean) => [...agents.values()],
    update: async (_id: string, _input: UpdateAgentInput) => {
      throw new Error("fakeAgentSvc.update not implemented");
    },
    archive: async (_id: string) => {
      throw new Error("fakeAgentSvc.archive not implemented");
    },
    hardDelete: async (_id: string) => {
      throw new Error("fakeAgentSvc.hardDelete not implemented");
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// fakeColumnConfigSvc (B — data stub for ColumnConfigService)
// ═══════════════════════════════════════════════════════════════

export function fakeColumnConfigSvc(transitions?: Transition[]): ColumnConfigService {
  const defaults: Transition[] = [
    {
      from: "planned",
      to: "in_progress",
      agentId: "planner",
      promptTemplate: "Plan for {{title}}",
      approvalPosture: "auto",
    },
    {
      from: "in_progress",
      to: "in_review",
      agentId: "developer",
      promptTemplate: "Work on {{title}}",
      approvalPosture: "auto",
    },
    {
      from: "in_review",
      to: "done",
      agentId: "reviewer",
      promptTemplate: "Review {{title}}",
      approvalPosture: "human",
    },
  ];

  return {
    port: {} as ColumnConfigService["port"],
    listByProject: () => [],
    upsert: async () => {
      throw new Error("fakeColumnConfigSvc.upsert not implemented");
    },
    remove: () => {
      throw new Error("fakeColumnConfigSvc.remove not implemented");
    },
    transitionsForProject: (_projectId: string) => transitions ?? defaults,
  };
}

// ═══════════════════════════════════════════════════════════════
// fakeDeliverableSvc (B — data stub)
// ═══════════════════════════════════════════════════════════════

export function fakeDeliverableSvc(
  rows: Array<{
    kind: string;
    fields: Record<string, string>;
    ref?: string;
    createdAt: number;
  }> = [],
): { listByIssue(issueId: string): DeliverableRow[] } {
  return {
    listByIssue(issueId: string) {
      return rows.map((r, i) => ({
        deliverableId: `d_${i}`,
        issueId,
        fromStatus: "planned",
        kind: r.kind,
        fields: r.fields,
        ref: r.ref ?? null,
        runId: `run_00${i}`,
        createdAt: r.createdAt,
      }));
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// fakeProjectSvc (B — data stub for project auto-orchestrate)
// ═══════════════════════════════════════════════════════════════

export function fakeProjectSvc(overrides?: { autoOrchestrate?: boolean; projectId?: string }): {
  getById(id: string): { autoOrchestrate: boolean; projectId: string };
} {
  return {
    getById: (id: string) => ({
      autoOrchestrate: overrides?.autoOrchestrate ?? true,
      projectId: overrides?.projectId ?? id,
    }),
  };
}

// ═══════════════════════════════════════════════════════════════
// fakeSessionFactory (C — placeholder, full impl in Phase 1)
// ═══════════════════════════════════════════════════════════════

export interface FakeSessionFactory {
  getOrCreate(
    sessionId: string,
    _spec: Record<string, unknown>,
  ): {
    prompt: (input: string, opts?: { signal?: AbortSignal; runId?: string }) => Promise<void>;
    dispose: () => void;
    state: string;
  };
  dispose(sessionId: string): void;
  created: Map<string, { session: ReturnType<FakeSessionFactory["getOrCreate"]> }>;
  promptCalls: Array<{ sessionId: string; input: string; runId?: string }>;
}

export function fakeSessionFactory(): FakeSessionFactory {
  const created = new Map<string, { session: ReturnType<FakeSessionFactory["getOrCreate"]> }>();
  const promptCalls: Array<{ sessionId: string; input: string; runId?: string }> = [];

  return {
    created,
    promptCalls,
    getOrCreate(sessionId: string, _spec: Record<string, unknown>) {
      const hit = created.get(sessionId);
      if (hit) return hit.session;

      const session = {
        state: "idle" as string,
        prompt: async (_input: string, opts?: { signal?: AbortSignal; runId?: string }) => {
          promptCalls.push({ sessionId, input: _input, runId: opts?.runId });
        },
        dispose: () => {
          created.delete(sessionId);
        },
      };
      created.set(sessionId, { session });
      return session;
    },
    dispose(sessionId: string) {
      created.get(sessionId)?.session.dispose();
      created.delete(sessionId);
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Builder helpers (fat deps → narrow test deps)
// ═══════════════════════════════════════════════════════════════

const DEFAULT_AGENTS = new Map<string, AgentRow>();
DEFAULT_AGENTS.set("planner", makeAgentRow({ id: "planner", name: "planner" }));
DEFAULT_AGENTS.set("developer", makeAgentRow({ id: "developer", name: "developer" }));
DEFAULT_AGENTS.set("reviewer", makeAgentRow({ id: "reviewer", name: "reviewer" }));

export function makeOrchestratorDeps(over?: Partial<OrchestratorDeps>): OrchestratorDeps {
  return {
    config: mockConfig() as OrchestratorDeps["config"],
    issueSvc: over?.issueSvc ?? ({} as any), // caller must provide real issueSvc
    agentSvc: over?.agentSvc ?? fakeAgentSvc(DEFAULT_AGENTS),
    supervisor: over?.supervisor ?? (recordingSupervisor() as unknown as RunSupervisor),
    opsStore: over?.opsStore ?? (mockOpsStore() as any),
    idGen: over?.idGen ?? (() => crypto.randomUUID()),
    columnConfigSvc:
      over?.columnConfigSvc ?? (fakeColumnConfigSvc() as unknown as ColumnConfigService),
    deliverableSvc: over?.deliverableSvc ?? fakeDeliverableSvc(),
    projectSvc: over?.projectSvc ?? fakeProjectSvc(),
    now: over?.now ?? (() => 1000000),
    ...over,
  };
}

/** Placeholder — full RunDeps type lands in Phase 1. */
export function makeRunDeps(over?: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionFactory: fakeSessionFactory(),
    supervisor: recordingSupervisor(),
    opsStore: mockOpsStore(),
    agentSvc: fakeAgentSvc(DEFAULT_AGENTS),
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════
// testIdGen + waitForFinalize (kept from original mock-deps)
// ═══════════════════════════════════════════════════════════════

let _idCount = 0;
export function testIdGen(): string {
  return `test-id-${_idCount++}`;
}

export async function waitForFinalize(
  s: RunSupervisor,
  runId: string,
  timeout = 5000,
): Promise<void> {
  const start = Date.now();
  while (s.getActive().has(runId) && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 50));
  }
}
