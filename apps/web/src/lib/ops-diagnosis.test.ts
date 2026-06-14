import { describe, test, expect } from "bun:test";
import {
  diagnoseRun,
  diagnoseRunListItem,
  isStaleRun,
  isDetachedRun,
  isUnhealthyAgent,
  hasSurfaceError,
} from "./ops-diagnosis";
import type { RunOpsDetail, RunOpsListItem, AgentRuntimeStatus } from "./api";

const HEARTBEAT_MS = 60_000;

function makeDetail(overrides: Partial<RunOpsDetail["run"]> & {
  transport?: string;
  heartbeatAgeMs?: number | null;
  opsKinds?: string[];
  lastEventType?: string | null;
} = {}): RunOpsDetail {
  return {
    run: {
      runId: "run-1",
      threadId: "thread-1",
      agentId: "agent-1",
      kind: "main",
      parentRunId: null,
      status: "running",
      traceId: null,
      startedAt: Date.now() - 10_000,
      endedAt: null,
      ...overrides,
    },
    attempts: [{
      attemptId: "att-1",
      heartbeatAt: Date.now() - 5_000,
      heartbeatAgeMs: overrides.heartbeatAgeMs ?? 5_000,
      startedAt: Date.now() - 10_000,
      endedAt: null,
      transport: overrides.transport ?? "attached",
    }],
    eventLog: {
      lastSeq: 5,
      lastEventType: overrides.lastEventType ?? "message",
      lastEventAt: Date.now() - 5_000,
    },
    ops: (overrides.opsKinds ?? []).map((kind, i) => ({
      seq: i + 1,
      kind,
      payload: {},
      traceId: null,
      ts: Date.now() - (10 - i) * 1000,
    })),
  };
}

function makeListItem(overrides: Partial<RunOpsListItem> = {}): RunOpsListItem {
  return {
    runId: "run-1",
    threadId: "thread-1",
    agentId: "agent-1",
    kind: "main",
    parentRunId: null,
    status: "running",
    traceId: null,
    startedAt: Date.now() - 10_000,
    endedAt: null,
    latestAttemptId: "att-1",
    heartbeatAgeMs: 5_000,
    runnerTransport: "attached",
    lastEventType: "message",
    lastOpsEventKind: null,
    ...overrides,
  };
}

// ── diagnoseRun ──

describe("diagnoseRun", () => {
  test("running + attached + fresh heartbeat → running", () => {
    const d = makeDetail({ transport: "attached", heartbeatAgeMs: 5_000 });
    expect(diagnoseRun(d, HEARTBEAT_MS)).toEqual({ kind: "running", owner: "unknown" });
  });

  test("running + noop → detached_waiting_reaper", () => {
    const d = makeDetail({ transport: "noop", heartbeatAgeMs: 5_000 });
    expect(diagnoseRun(d, HEARTBEAT_MS)).toEqual({ kind: "detached_waiting_reaper", owner: "backend_runner_link" });
  });

  test("running + detached → detached_waiting_reaper", () => {
    const d = makeDetail({ transport: "detached", heartbeatAgeMs: 5_000 });
    expect(diagnoseRun(d, HEARTBEAT_MS)).toEqual({ kind: "detached_waiting_reaper", owner: "backend_runner_link" });
  });

  test("running + stale heartbeat → heartbeat_stale", () => {
    const d = makeDetail({ transport: "attached", heartbeatAgeMs: 120_000 });
    expect(diagnoseRun(d, HEARTBEAT_MS)).toEqual({ kind: "heartbeat_stale", owner: "runner" });
  });

  test("terminal succeeded → terminal", () => {
    const d = makeDetail({ status: "succeeded" });
    expect(diagnoseRun(d, HEARTBEAT_MS)).toEqual({ kind: "terminal", owner: "none" });
  });

  test("terminal error → terminal", () => {
    const d = makeDetail({ status: "error" });
    expect(diagnoseRun(d, HEARTBEAT_MS)).toEqual({ kind: "terminal", owner: "none" });
  });

  test("running + reattach_failed ops → surface_projection_failed", () => {
    const d = makeDetail({
      transport: "attached",
      heartbeatAgeMs: 5_000,
      opsKinds: ["attempt_started", "reattach_failed"],
    });
    expect(diagnoseRun(d, HEARTBEAT_MS)).toEqual({ kind: "surface_projection_failed", owner: "surface" });
  });

  test("stale heartbeat trumps transport detachment", () => {
    const d = makeDetail({ transport: "noop", heartbeatAgeMs: 120_000 });
    expect(diagnoseRun(d, HEARTBEAT_MS)).toEqual({ kind: "detached_waiting_reaper", owner: "backend_runner_link" });
  });
});

// ── diagnoseRunListItem ──

describe("diagnoseRunListItem", () => {
  test("running + attached → running", () => {
    const item = makeListItem({ runnerTransport: "attached", heartbeatAgeMs: 5_000 });
    expect(diagnoseRunListItem(item, HEARTBEAT_MS)).toEqual({ kind: "running", owner: "unknown" });
  });

  test("running + noop → detached_waiting_reaper", () => {
    const item = makeListItem({ runnerTransport: "noop" });
    expect(diagnoseRunListItem(item, HEARTBEAT_MS)).toEqual({ kind: "detached_waiting_reaper", owner: "backend_runner_link" });
  });

  test("terminal → terminal", () => {
    const item = makeListItem({ status: "succeeded" });
    expect(diagnoseRunListItem(item, HEARTBEAT_MS)).toEqual({ kind: "terminal", owner: "none" });
  });
});

// ── Overview helpers ──

describe("health predicates", () => {
  test("isStaleRun detects stale heartbeat", () => {
    expect(isStaleRun(makeListItem({ heartbeatAgeMs: 120_000 }), HEARTBEAT_MS)).toBe(true);
    expect(isStaleRun(makeListItem({ heartbeatAgeMs: 5_000 }), HEARTBEAT_MS)).toBe(false);
    expect(isStaleRun(makeListItem({ status: "succeeded", heartbeatAgeMs: 120_000 }), HEARTBEAT_MS)).toBe(false);
    expect(isStaleRun(makeListItem({ heartbeatAgeMs: null }), HEARTBEAT_MS)).toBe(false);
  });

  test("isDetachedRun detects noop/detached", () => {
    expect(isDetachedRun(makeListItem({ runnerTransport: "noop" }))).toBe(true);
    expect(isDetachedRun(makeListItem({ runnerTransport: "detached" }))).toBe(true);
    expect(isDetachedRun(makeListItem({ runnerTransport: "attached" }))).toBe(false);
    expect(isDetachedRun(makeListItem({ runnerTransport: "noop", status: "succeeded" }))).toBe(false);
  });

  test("isUnhealthyAgent flags degraded/offline runners", () => {
    const base: AgentRuntimeStatus = {
      agentId: "a", heartbeatTimeoutMs: 60_000,
      runner: { status: "busy", lastSeenAt: Date.now(), uptimeMs: 1000, activeRunCount: 1, checkpointerOk: true, workspaceOk: true, lastError: null },
      surfaces: {},
    };
    expect(isUnhealthyAgent(base)).toBe(false);
    expect(isUnhealthyAgent({ ...base, runner: { ...base.runner, checkpointerOk: false } })).toBe(true);
    expect(isUnhealthyAgent({ ...base, runner: { ...base.runner, workspaceOk: false } })).toBe(true);
    expect(isUnhealthyAgent({ ...base, runner: { ...base.runner, status: "offline" } })).toBe(true);
    expect(isUnhealthyAgent({ ...base, runner: { ...base.runner, status: "degraded" } })).toBe(true);
  });

  test("hasSurfaceError detects non-running surfaces", () => {
    const base: AgentRuntimeStatus = {
      agentId: "a", heartbeatTimeoutMs: 60_000,
      runner: { status: "busy", lastSeenAt: Date.now(), uptimeMs: 1000, activeRunCount: 1, checkpointerOk: true, workspaceOk: true, lastError: null },
      surfaces: {},
    };
    expect(hasSurfaceError(base)).toBe(false);
    expect(hasSurfaceError({
      ...base,
      surfaces: { lark: { status: "degraded", lastSeenAt: Date.now(), lastError: null, counters: {} } },
    })).toBe(true);
  });
});
