/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatModel } from "@my-agent-team/core";
import type { SessionConfig } from "@my-agent-team/harness";
import type { RuntimeTracer } from "@my-agent-team/runtime-observability";
import { type EchoScript, echoModel } from "@my-agent-team/test-helpers";
import type { AgentRow, CreateAgentInput, UpdateAgentInput } from "../src/features/agent/domain.js";
import type { AgentService } from "../src/features/agent/service.js";
import { RuntimeOpsStore } from "../src/features/runtime-ops/store.js";
import { SpanSupervisor } from "../src/features/span/supervisor.js";
import { openDb } from "../src/infra/sqlite/db.js";

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
  // S1: events.db merged into backend.db — openDb runs unified migration (all tables).
  return openDb(":memory:");
}

/** Like testDB but also runs the main backend drizzle migrations (schema.ts → issue table etc). */
export function testMainDB(): Database {
  return openDb(":memory:");
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
    builtinSkillsDir: join(dir, "builtin-skills-test"),
  };
}

// ═══════════════════════════════════════════════════════════════
// Mock services (B — data stubs)
// ═══════════════════════════════════════════════════════════════

export function mockOpsStore() {
  return {
    insertSpanOrigin: () => {},
    getSpanOrigin: () => null,
    appendControlPlaneEvent: () => {},
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

export function mockSupervisor(db: Database): SpanSupervisor {
  return new SpanSupervisor({
    config: mockConfig(),
    opsStore: new RuntimeOpsStore(db),
    tracer: {
      inject: () => ({ traceId: "", traceparent: "" }),
      startSpan: () => ({}),
      currentTrace: () => null,
      link: () => {},
    } as unknown as RuntimeTracer,
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
  /** spanId = current spanId (product semantics: one prompt loop). */
  span: (s = "sp1") => s,
};

// ═══════════════════════════════════════════════════════════════
// RecordingSupervisor (A — recording spy)
// ═══════════════════════════════════════════════════════════════

export interface RecordingSupervisor {
  startedRuns: Array<{ spanId: string; sessionId: string; origin?: unknown }>;
  getActive(): ReadonlyMap<string, { abortController: AbortController }>;
  startMainRun(
    spanId: string,
    sessionId: string,
    spec: Record<string, unknown>,
  ): Promise<{ spanId: string; attemptSeq: number }>;
  startSpan(
    spanId: string,
    sessionId: string,
    origin?: unknown,
  ): Promise<{
    spanId: string;
    sessionId: string;
    end: (status: string, errorMessage?: string) => void;
  }>;
  cancel(spanId: string): boolean;
  onRunComplete(
    fn: (sessionId: string, spanId: string, status: string, kind: string) => void | Promise<void>,
  ): void;
  notifyRunComplete(spanId: string, status: string): Promise<void>;
  getDb(): { query: (_sql: string) => { get: () => unknown } };
}

export function recordingSupervisor(): RecordingSupervisor {
  const startedRuns: Array<{
    spanId: string;
    sessionId: string;
    origin?: unknown;
  }> = [];
  const active = new Map<string, { abortController: AbortController }>();
  const completeHandlers: Array<
    (sessionId: string, spanId: string, status: string, kind: string) => void | Promise<void>
  > = [];

  return {
    startedRuns,
    getActive: () => active as ReadonlyMap<string, { abortController: AbortController }>,
    startMainRun: async (spanId: string, sessionId: string, spec: Record<string, unknown>) => {
      startedRuns.push({ spanId, sessionId, origin: spec });
      active.set(spanId, { abortController: new AbortController() });
      return { spanId, attemptSeq: 1 };
    },
    startSpan: async (spanId: string, sessionId: string, origin?: unknown) => {
      startedRuns.push({ spanId, sessionId, origin });
      active.set(spanId, { abortController: new AbortController() });
      let ended = false;
      return {
        spanId,
        sessionId,
        end: (status: string, _errorMessage?: string) => {
          if (ended) return;
          ended = true;
          active.delete(spanId);
          for (const h of completeHandlers) {
            void h(sessionId, spanId, status, "main");
          }
        },
      };
    },
    cancel: (spanId: string) => {
      active.get(spanId)?.abortController.abort();
      return true;
    },
    onRunComplete: (
      fn: (sessionId: string, spanId: string, status: string, kind: string) => void | Promise<void>,
    ) => {
      completeHandlers.push(fn);
    },
    notifyRunComplete: async (spanId: string, status: string) => {
      for (const h of completeHandlers) {
        await h("", spanId, status, "main");
      }
    },
    getDb: () => ({ query: () => ({ get: () => null }) }),
  };
}

// ═══════════════════════════════════════════════════════════════
// recordingRunStatus (A — recording spy for onRunStatus)
// ═══════════════════════════════════════════════════════════════

export function recordingRunStatus(): {
  calls: Array<{ spanId: string; phase: string; detail?: string }>;
  onRunStatus: (s: { spanId: string; phase: string; detail?: string; updatedAt: number }) => void;
} {
  const calls: Array<{ spanId: string; phase: string; detail?: string }> = [];
  return {
    calls,
    onRunStatus: (s) => {
      calls.push({ spanId: s.spanId, phase: s.phase, detail: s.detail });
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
// fakeSessionManager (replaces FakeSessionFactory for new SessionManager API)
// ═══════════════════════════════════════════════════════════════

export interface FakeSession {
  sessionId: string;
  prompt: (
    input: string,
    opts?: { signal?: AbortSignal; spanId?: string; origin?: unknown; conversation?: unknown },
  ) => Promise<void>;
  resume: (opts: { approved: boolean; message?: string }) => Promise<void>;
  dispose: () => void;
  state: string;
  subscribe: (fn: (event: unknown) => void) => () => void;
}

export interface FakeSessionManager {
  create(config: SessionConfig): FakeSession;
  open(sessionId: string, config: SessionConfig): FakeSession;
  get(sessionId: string): FakeSession | undefined;
  dispose(sessionId: string): void;
  created: Map<string, FakeSession>;
  resumeCalls: Array<{ sessionId: string; approved: boolean; message?: string }>;
}

export function fakeSessionManager(): FakeSessionManager {
  const created = new Map<string, FakeSession>();
  const resumeCalls: Array<{ sessionId: string; approved: boolean; message?: string }> = [];
  let idCounter = 0;

  function makeSession(sessionId: string): FakeSession {
    return {
      sessionId,
      state: "idle",
      prompt: async () => {},
      resume: async (opts: { approved: boolean; message?: string }) => {
        resumeCalls.push({ sessionId, approved: opts.approved, message: opts.message });
      },
      dispose: () => {
        created.delete(sessionId);
      },
      subscribe: () => () => {},
    };
  }

  return {
    created,
    resumeCalls,
    create(_config: SessionConfig): FakeSession {
      const sessionId = `fake-sid-${++idCounter}`;
      const session = makeSession(sessionId);
      created.set(sessionId, session);
      return session;
    },
    open(sessionId: string, _config: SessionConfig): FakeSession {
      const existing = created.get(sessionId);
      if (existing) return existing;
      const session = makeSession(sessionId);
      created.set(sessionId, session);
      return session;
    },
    get(sessionId: string): FakeSession | undefined {
      return created.get(sessionId);
    },
    dispose(sessionId: string): void {
      created.get(sessionId)?.dispose();
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// fakeGetSessionIdByRunId (B — data stub for resume route DI)
// ═══════════════════════════════════════════════════════════════

/** Returns a (spanId: string) => string | null stub from a static map. */
export function fakeGetSessionIdByRunId(
  map: Record<string, string>,
): (spanId: string) => string | null {
  return (spanId: string) => map[spanId] ?? null;
}

// ═══════════════════════════════════════════════════════════════
// fakeCheckpointEventsStore (C — memory stub for Ops tests, PR-3)
// ═══════════════════════════════════════════════════════════════

/** Spread event shape matching CheckpointEventRow from framework:
 *  { ...CheckpointEvent, spanId, ts } — fields are flat, not nested. */
export interface CheckpointEventRow {
  type: string;
  spanId: string | null;
  ts: number;
  sessionId?: string;
  [key: string]: unknown;
}

export interface FakeCheckpointEventsStore {
  readBySpan(sessionId: string, spanId: string): CheckpointEventRow[];
  readBySession(sessionId: string): CheckpointEventRow[];
  readWindow(_from: number, _to: number): CheckpointEventRow[];
  appended: CheckpointEventRow[];
}

export function fakeCheckpointEventsStore(rows?: CheckpointEventRow[]): FakeCheckpointEventsStore {
  const store: CheckpointEventRow[] = [...(rows ?? [])];
  return {
    appended: store,
    readBySpan(sessionId: string, spanId: string) {
      return store.filter((r) => r.sessionId === sessionId && r.spanId === spanId);
    },
    readBySession(sessionId: string) {
      return store.filter((r) => r.sessionId === sessionId);
    },
    readWindow(_from: number, _to: number) {
      return store.filter((r) => r.ts >= _from && r.ts <= _to);
    },
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
  s: SpanSupervisor,
  spanId: string,
  timeout = 5000,
): Promise<void> {
  const start = Date.now();
  while (s.getActive().has(spanId) && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ═══════════════════════════════════════════════════════════════
// fakeModel (C — scripted ChatModel for deterministic tests)
// ═══════════════════════════════════════════════════════════════

const DEFAULT_ECHO_SCRIPT: EchoScript = { turns: [{ type: "text", text: "ok" }] };

/** Return an echoModel preloaded with a default ok-response script.
 *  Pass a custom EchoScript to control the assistant's output. */
export function fakeModel(script?: EchoScript): ChatModel {
  return echoModel(script ?? DEFAULT_ECHO_SCRIPT);
}
