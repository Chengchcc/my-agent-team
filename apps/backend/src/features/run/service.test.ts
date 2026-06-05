import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@my-agent-team/framework";
import type { RunRow } from "./domain.js";
import { createRunService, RunNotFoundError, ThreadBusyError } from "./service.js";

interface RunPort {
  create(input: { id: string; threadId: string; input: string; status: string; startedAt: number }): RunRow;
  findById(id: string): RunRow | null;
  updateStatus(id: string, status: string, errorMessage?: string, endedAt?: number): RunRow | null;
  listByThread(threadId: string): RunRow[];
}

function makePort(): RunPort {
  const rows = new Map<string, RunRow>();
  return {
    create(input) {
      const row: RunRow = { ...input, errorMessage: null, endedAt: null };
      rows.set(input.id, row); return row;
    },
    findById(id) { return rows.get(id) ?? null; },
    updateStatus(id, status, errorMessage, endedAt) {
      const r = rows.get(id); if (!r) return null;
      r.status = status; if (errorMessage !== undefined) r.errorMessage = errorMessage;
      if (endedAt !== undefined) r.endedAt = endedAt; return r;
    },
    listByThread(threadId) {
      return [...rows.values()].filter((r) => r.threadId === threadId);
    },
  };
}

async function* makeRunner(): AsyncIterable<AgentEvent> {
  yield { type: "message", payload: { role: "assistant", content: "ok" } } as AgentEvent;
}

describe("RunService", () => {
  test("start creates run record and returns SSE stream", async () => {
    const svc = createRunService({
      port: makePort(), idGen: () => "run-1",
      runner: () => makeRunner(),
      threads: new Set(),
      abortMap: new Map(),
      threadSvc: { touchLastRun: () => {} } as any,
    });

    const events: AgentEvent[] = [];
    for await (const ev of svc.start("th-1", "hello")) {
      events.push(ev);
    }

    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("message");
  });

  test("start throws ThreadBusyError when thread already running", () => {
    const threads = new Set<string>(["th-1"]);
    const svc = createRunService({
      port: makePort(), idGen: () => "run-1",
      runner: () => makeRunner(),
      threads,
      abortMap: new Map(),
      threadSvc: { touchLastRun: () => {} } as any,
    });

    // Async generator throws synchronously when function runs
    expect(() => svc.start("th-1", "hi")).toThrow(ThreadBusyError);
  });

  test("cancel aborts a running run", async () => {
    const threads = new Set<string>();
    const abortMap = new Map<string, AbortController>();

    // Runner that never yields — only stops on abort
    async function* hangingRunner(_spec: unknown, signal: AbortSignal): AsyncIterable<AgentEvent> {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve());
      });
    }

    const svc = createRunService({
      port: makePort(), idGen: () => "run-1",
      runner: hangingRunner,
      threads,
      abortMap,
      threadSvc: { touchLastRun: () => {} } as any,
    });

    const evs: AgentEvent[] = [];
    const done = (async () => {
      for await (const ev of svc.start("th-1", "hi")) evs.push(ev);
    })();

    // Cancel after a tick
    await new Promise((r) => setTimeout(r, 10));
    svc.cancel("run-1");

    await done;
    expect(abortMap.has("run-1")).toBe(false);
  });

  test("cancel throws RunNotFoundError for unknown runId", () => {
    const svc = createRunService({
      port: makePort(), idGen: () => "run-1",
      runner: () => makeRunner(),
      threads: new Set(),
      abortMap: new Map(),
      threadSvc: { touchLastRun: () => {} } as any,
    });

    expect(() => svc.cancel("nonexistent")).toThrow(RunNotFoundError);
  });
});
