import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { EventLog, EventRecord, ReadQuery, SubscribeOptions } from "@my-agent-team/event-log";
import { runRoutes } from "./http.js";
import { createRunService } from "./service.js";
import type { RunSupervisor } from "./supervisor.js";

// ── Mocks ──────────────────────────────────────────────────────────

function makeMockSupervisor(overrides?: Partial<RunSupervisor>): RunSupervisor {
  return {
    activeCount: 0,
    start: () => ({ runId: "run-1", attemptId: "att-1", pid: 12345 }),
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

async function collectSSE(res: Response): Promise<string[]> {
  if (!res.body) return [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.split("\n\n").filter(Boolean);
}

// ── Tests ──────────────────────────────────────────────────────────

describe("Run HTTP", () => {
  // ── POST /runs ─────────────────────────────────────────────────

  test("POST /runs returns 202 with runId and attemptId", async () => {
    const svc = createRunService({
      supervisor: makeMockSupervisor(),
      eventLog: makeMockEventLog(),
      maxConcurrentRuns: 8,
      threads: new Set(),
      idGen: () => "run-1",
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
      threads: new Set(["t1"]),
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
      threads: new Set(),
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
      threads: new Set(),
      idGen: () => "run-1",
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
      threads: new Set(),
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
      threads: new Set(),
      idGen: () => "run-1",
    });
    const routes = runRoutes(svc, async () => ({}));

    const res = await routes.cancel(makeRequest("/api/runs/x/cancel", { method: "POST" }), "x");
    expect(res.status).toBe(404);
  });

  // ── GET /events SSE ────────────────────────────────────────────

  test("GET /events returns SSE with id framing and done event", async () => {
    const mockLog: EventLog = {
      ...makeMockEventLog(),
      subscribe: async function* (
        _query?: ReadQuery,
        _opts?: SubscribeOptions,
        _signal?: AbortSignal,
      ) {
        yield {
          seq: 1,
          threadId: "t1",
          runId: "r1",
          event: { type: "message", payload: { role: "assistant" as const, content: "hi" } },
          ts: 1,
        } as EventRecord;
        yield {
          seq: 2,
          threadId: "t1",
          runId: "r1",
          event: { type: "message", payload: { role: "assistant" as const, content: "there" } },
          ts: 2,
        } as EventRecord;
      },
    };

    const svc = createRunService({
      supervisor: makeMockSupervisor(),
      eventLog: mockLog,
      maxConcurrentRuns: 8,
      threads: new Set(),
      idGen: () => "run-1",
    });
    const routes = runRoutes(svc, async () => ({}));

    const res = await routes.events(makeRequest("/api/runs/r1/events"), "r1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");

    const frames = await collectSSE(res);
    expect(frames.length).toBeGreaterThanOrEqual(2); // at least 2 event frames + maybe done
    // First frame should have id
    expect(frames[0]).toContain("id: 1");
    // Last frame should be done
    const last = frames[frames.length - 1]!;
    expect(last).toContain("event: done");
  });

  test("GET /events respects Last-Event-ID header", async () => {
    let receivedAfterSeq: number | undefined;
    const mockLog: EventLog = {
      ...makeMockEventLog(),
      subscribe: async function* (
        _query?: ReadQuery,
        _opts?: SubscribeOptions,
        _signal?: AbortSignal,
      ) {
        receivedAfterSeq = _query?.afterSeq;
        yield {
          seq: 6,
          threadId: "t1",
          runId: "r1",
          event: { type: "message", payload: { role: "assistant" as const, content: "after5" } },
          ts: 6,
        } as EventRecord;
      },
    };

    const svc = createRunService({
      supervisor: makeMockSupervisor(),
      eventLog: mockLog,
      maxConcurrentRuns: 8,
      threads: new Set(),
      idGen: () => "run-1",
    });
    const routes = runRoutes(svc, async () => ({}));

    const res = await routes.events(
      makeRequest("/api/runs/r1/events", { headers: { "Last-Event-ID": "5" } }),
      "r1",
    );
    expect(res.status).toBe(200);
    // afterSeq should be 5
    expect(receivedAfterSeq).toBe(5);
  });

  test("GET /events closes gracefully on AbortSignal", async () => {
    const mockLog: EventLog = {
      ...makeMockEventLog(),
      // eslint-disable-next-line require-yield
      subscribe: async function* (
        _query?: ReadQuery,
        _opts?: SubscribeOptions,
        _signal?: AbortSignal,
      ) {
        // never yields — subscriber is aborted
        await new Promise(() => {});
      },
    };

    const svc = createRunService({
      supervisor: makeMockSupervisor(),
      eventLog: mockLog,
      maxConcurrentRuns: 8,
      threads: new Set(),
      idGen: () => "run-1",
    });
    const routes = runRoutes(svc, async () => ({}));

    const ac = new AbortController();
    const req = new Request("http://localhost/api/runs/r1/events", { signal: ac.signal });
    const resPromise = routes.events(req, "r1");

    // Abort after a short delay
    setTimeout(() => ac.abort(), 50);
    const res = await resPromise;
    // Should close without throwing
    expect(res.status).toBe(200);
  });

  // ── POST /resume ────────────────────────────────────────────────

  test("POST /resume returns 202 with new attemptId", async () => {
    let forked = false;
    const svc = createRunService({
      supervisor: makeMockSupervisor({
        start: () => {
          forked = true;
          return { runId: "r1", attemptId: "att-2", pid: 9999 };
        },
      }),
      eventLog: makeMockEventLog(),
      maxConcurrentRuns: 8,
      threads: new Set(),
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
      threads: new Set(),
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
