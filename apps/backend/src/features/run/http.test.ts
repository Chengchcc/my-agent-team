import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { ConversationLock } from "../conversation/lock.js";
import type { EventLog, EventRecord } from "../event-log/index.js";
import { runRoutes } from "./http.js";
import { createRunService } from "./service.js";
import type { RunSupervisor } from "./supervisor.js";

// ── Mocks ──────────────────────────────────────────────────────────

function makeMockSupervisor(overrides?: Partial<RunSupervisor>): RunSupervisor {
  return {
    activeCount: 0,
    startMainRun: async () => ({ runId: "run-1", attemptId: "att-1" }),
    resumeRun: async () => ({ runId: "run-1", attemptId: "att-1" }),
    cancel: () => true,
    rediscover: async () => {},
    onRunComplete: () => {},
    dispose: () => {},
    cancelByPid: () => true,
    getDb: () => ({ query: () => ({ get: () => null }) }) as unknown as RunSupervisor["getDb"],
    ...overrides,
  } as unknown as RunSupervisor;
}

function makeMockEventLog(): EventLog {
  const noopSubscribe: EventLog["subscribe"] = () =>
    (async function* () {})() as AsyncIterable<EventRecord>;
  return {
    append: async () => 1,
    read: async () => [],
    subscribe: noopSubscribe,
  };
}

function makeRequest(
  path: string,
  opts?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Request {
  return new Request(`http://localhost${path}`, {
    method: opts?.method ?? "GET",
    headers: { "Content-Type": "application/json", ...opts?.headers },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
}

// ── Tests ──────────────────────────────────────────────────────────

describe("Run HTTP", () => {
  // ── POST /runs ─────────────────────────────────────────────────

  test("POST /runs returns 202 with runId and attemptId", async () => {
    const svc = createRunService({
      supervisor: makeMockSupervisor(),
      eventLog: makeMockEventLog(),
      maxConcurrentRuns: 8,
      lock: new ConversationLock(),
      idGen: () => "run-1",
      dispatcher: {
        dispatch: async (c: Record<string, unknown>) => ({
          runId: c.runId as string,
          attemptId: "att-1",
        }),
      },
    });
    const routes = runRoutes(svc, async () => ({}));

    const res = await routes.run(
      makeRequest("/api/threads/t1/runs", { method: "POST", body: { input: "hello" } }),
      "t1",
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string; attemptId: string };
    expect(body.runId).toBe("run-1");
    expect(body.attemptId).toBe("att-1");
  });

  test("POST /runs returns 409 when thread busy", async () => {
    const svc = createRunService({
      supervisor: makeMockSupervisor(),
      eventLog: makeMockEventLog(),
      maxConcurrentRuns: 8,
      lock: (() => {
        const l = new ConversationLock();
        l.acquireThread("t1", "t1");
        return l;
      })(),
      idGen: () => "run-1",
    });
    const routes = runRoutes(svc, async () => ({}));

    const res = await routes.run(
      makeRequest("/api/threads/t1/runs", { method: "POST", body: { input: "hello" } }),
      "t1",
    );
    expect(res.status).toBe(409);
  });

  test("POST /runs returns 429 when at capacity", async () => {
    const svc = createRunService({
      supervisor: makeMockSupervisor({ activeCount: 8 }),
      eventLog: makeMockEventLog(),
      maxConcurrentRuns: 8,
      lock: new ConversationLock(),
      idGen: () => "run-1",
    });
    const routes = runRoutes(svc, async () => ({}));

    const res = await routes.run(
      makeRequest("/api/threads/t1/runs", { method: "POST", body: { input: "hello" } }),
      "t1",
    );
    expect(res.status).toBe(429);
  });

  test("POST /runs returns 400 on invalid body", async () => {
    const svc = createRunService({
      supervisor: makeMockSupervisor(),
      eventLog: makeMockEventLog(),
      maxConcurrentRuns: 8,
      lock: new ConversationLock(),
      idGen: () => "run-1",
      dispatcher: {
        dispatch: async (c: Record<string, unknown>) => ({
          runId: c.runId as string,
          attemptId: "att-1",
        }),
      },
    });
    const routes = runRoutes(svc, async () => ({}));

    const res = await routes.run(
      makeRequest("/api/threads/t1/runs", { method: "POST", body: {} }),
      "t1",
    );
    expect(res.status).toBe(400);
  });

  // ── POST /cancel ────────────────────────────────────────────────

  test("POST /cancel returns 204 on success", async () => {
    const svc = createRunService({
      supervisor: makeMockSupervisor({ cancel: () => true }),
      eventLog: makeMockEventLog(),
      maxConcurrentRuns: 8,
      lock: new ConversationLock(),
      idGen: () => "run-1",
    });
    const routes = runRoutes(svc, async () => ({}));

    const res = await routes.cancel(makeRequest("/api/runs/r1/cancel", { method: "POST" }), "r1");
    expect(res.status).toBe(204);
  });

  test("POST /cancel returns 404 for unknown run", async () => {
    const svc = createRunService({
      supervisor: makeMockSupervisor({ cancel: () => false }),
      eventLog: makeMockEventLog(),
      maxConcurrentRuns: 8,
      lock: new ConversationLock(),
      idGen: () => "run-1",
    });
    const routes = runRoutes(svc, async () => ({}));

    const res = await routes.cancel(makeRequest("/api/runs/x/cancel", { method: "POST" }), "x");
    expect(res.status).toBe(404);
  });

  // ── POST /resume ────────────────────────────────────────────────

  test("POST /resume returns 202 with new attemptId", async () => {
    let forked = false;
    const svc = createRunService({
      supervisor: makeMockSupervisor({
        resumeRun: async () => {
          forked = true;
          return { runId: "r1", attemptId: "att-2" };
        },
      }),
      eventLog: makeMockEventLog(),
      maxConcurrentRuns: 8,
      lock: new ConversationLock(),
      idGen: () => "run-1",
    });
    const routes = runRoutes(
      svc,
      async () => ({}),
      async () => "t1",
    );

    const res = await routes.resume(
      makeRequest("/api/runs/r1/resume", { method: "POST", body: { approved: true } }),
      "r1",
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string; attemptId: string };
    expect(body.runId).toBe("r1");
    expect(forked).toBe(true);
  });

  // ── GET /:id ────────────────────────────────────────────────────

  test("GET /:id returns run metadata", async () => {
    const mockDb = {
      query: () => ({
        get: (id: string) =>
          id === "r1"
            ? { run_id: "r1", status: "running", started_at: 1, ended_at: null }
            : undefined,
      }),
    };
    const svc = createRunService({
      supervisor: makeMockSupervisor({ getDb: () => mockDb as unknown as Database }),
      eventLog: makeMockEventLog(),
      maxConcurrentRuns: 8,
      lock: new ConversationLock(),
      idGen: () => "run-1",
    });
    const routes = runRoutes(svc, async () => ({}));

    const res = await routes.getById(makeRequest("/api/runs/r1"), "r1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; status: string };
    expect(body.runId).toBe("r1");
    expect(body.status).toBe("running");
  });
});
