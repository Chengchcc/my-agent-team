import type { Database } from "bun:sqlite";
import type { AgentConfig as SessionConfig } from "@my-agent-team/agent";
import type { RuntimeTracer } from "@my-agent-team/runtime-observability";
import { RuntimeOpsStore } from "../src/features/runtime-ops/store.js";
import { SpanSupervisor } from "../src/features/span/supervisor.js";
import { mockConfig } from "./mock-general.js";

// ═══════════════════════════════════════════════════════════════
// mockOpsStore (B - data stub)
// ═══════════════════════════════════════════════════════════════

export function mockOpsStore() {
  return {
    insertSpanOrigin: () => {},
    getSpanOrigin: () => null,
    appendControlPlaneEvent: () => {},
  };
}

// ═══════════════════════════════════════════════════════════════
// mockSupervisor
// ═══════════════════════════════════════════════════════════════

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
// RecordingSupervisor (A - recording spy)
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
// recordingRunStatus (A - recording spy for onRunStatus)
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
// fakeCheckpointEventsStore (C - memory stub for Ops tests, PR-3)
// ═══════════════════════════════════════════════════════════════

/** Spread event shape matching CheckpointEventRow from framework:
 *  { ...CheckpointEvent, spanId, ts } - fields are flat, not nested. */
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
// fakeGetSessionIdByRunId (B - data stub for resume route DI)
// ═══════════════════════════════════════════════════════════════

/** Returns a (spanId: string) => string | null stub from a static map. */
export function fakeGetSessionIdByRunId(
  map: Record<string, string>,
): (spanId: string) => string | null {
  return (spanId: string) => map[spanId] ?? null;
}
