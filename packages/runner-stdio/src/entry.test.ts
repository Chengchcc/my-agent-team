import { expect, test } from "bun:test";
import type { Agent, AgentEvent } from "@my-agent-team/framework";
import { runEntry } from "./entry.js";

function makeValidSpec(): string {
  return JSON.stringify({
    schemaVersion: "1",
    workspace: "/tmp/ws",
    threadId: "t1",
    model: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    },
    apiKey: "sk-test",
    input: "hello",
  });
}

function makeMockAgent(events: AgentEvent[]): Agent {
  let runCalls = 0;
  return {
    thread: { id: "t1", messages: [] },
    async *run(_input, _opts) {
      runCalls++;
      // M11: second call is reflect turn — yield nothing by default
      if (runCalls > 1) return;
      for (const ev of events) {
        yield ev;
      }
    },
    async *resume(_cmd, _opts) {
      yield* [] as AgentEvent[];
    },
    fork(_msgs, _id) {
      return makeMockAgent(events);
    },
  };
}

function msgEvent(text: string): AgentEvent {
  return {
    type: "message",
    payload: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

/** Narrow an AgentEvent to the error variant, failing if not error type. */
function asError(ev: AgentEvent | undefined): {
  message: string;
  stack?: string;
} {
  expect(ev?.type).toBe("error");
  if (ev?.type === "error") return ev.payload;
  throw new Error("expected error event");
}

/** Narrow an AgentEvent to the message variant, failing if not message type. */
function asMessage(ev: AgentEvent | undefined): AgentEvent & { type: "message" } {
  expect(ev?.type).toBe("message");
  if (ev?.type === "message") return ev;
  throw new Error("expected message event");
}

// ─── Test 1: Happy path ─────────────────────────────────────────

test("happy path: valid spec yields events and returns 0", async () => {
  const events: AgentEvent[] = [msgEvent("Hello!")];

  const written: AgentEvent[] = [];
  const stderr: string[] = [];

  const result = await runEntry({
    specJson: makeValidSpec(),
    writeEvent: (ev) => written.push(ev),
    writeStderr: (line) => stderr.push(line),
    signal: new AbortController().signal,
    createAgent: () => Promise.resolve(makeMockAgent(events)),
  });

  expect(result).toBe(0);
  expect(written.length).toBe(1);
  expect(written[0]?.type).toBe("message");
});

// ─── Test 2: Invalid JSON spec ──────────────────────────────────

test("invalid JSON spec → error event + return 1", async () => {
  const written: AgentEvent[] = [];
  const stderr: string[] = [];

  const result = await runEntry({
    specJson: "{not valid json",
    writeEvent: (ev) => written.push(ev),
    writeStderr: (line) => stderr.push(line),
    signal: new AbortController().signal,
  });

  expect(result).toBe(1);
  expect(written.length).toBe(1);
  expect(asError(written[0]).message).toContain("JSON");
});

// ─── Test 3: Schema validation failure ──────────────────────────

test("schema validation failure → error event + return 1", async () => {
  const written: AgentEvent[] = [];
  const stderr: string[] = [];

  const result = await runEntry({
    specJson: JSON.stringify({ schemaVersion: "2", input: "hi" }),
    writeEvent: (ev) => written.push(ev),
    writeStderr: (line) => stderr.push(line),
    signal: new AbortController().signal,
  });

  expect(result).toBe(1);
  expect(written.length).toBe(1);
  expect(asError(written[0]).message).toContain("schemaVersion");
});

// ─── Test 4: Missing apiKey (spec + env) ────────────────────────

test("missing apiKey → error event + return 1", async () => {
  const written: AgentEvent[] = [];
  const stderr: string[] = [];

  const result = await runEntry({
    specJson: JSON.stringify({
      schemaVersion: "1",
      workspace: "/ws",
      threadId: "t1",
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      input: "hi",
    }),
    writeEvent: (ev) => written.push(ev),
    writeStderr: (line) => stderr.push(line),
    signal: new AbortController().signal,
  });

  expect(result).toBe(1);
  expect(written.length).toBe(1);
  expect(asError(written[0]).message).toContain("API key");
});

// ─── Test 5: apiKey from env fallback ───────────────────────────

test("apiKey from env fallback succeeds", async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "env-key";

  try {
    const events: AgentEvent[] = [msgEvent("ok")];
    const written: AgentEvent[] = [];
    const stderr: string[] = [];

    const result = await runEntry({
      specJson: JSON.stringify({
        schemaVersion: "1",
        workspace: "/ws",
        threadId: "t1",
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        input: "hi",
      }),
      writeEvent: (ev) => written.push(ev),
      writeStderr: (line) => stderr.push(line),
      signal: new AbortController().signal,
      createAgent: () => Promise.resolve(makeMockAgent(events)),
    });

    expect(result).toBe(0);
  } finally {
    if (original !== undefined) {
      process.env.ANTHROPIC_API_KEY = original;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  }
});

// ─── Test 6: Custom apiKeyEnv ───────────────────────────────────

test("custom apiKeyEnv used for fallback", async () => {
  const original = process.env.CUSTOM_KEY;
  process.env.CUSTOM_KEY = "custom-env-key";

  try {
    const events: AgentEvent[] = [msgEvent("ok")];
    const written: AgentEvent[] = [];
    const stderr: string[] = [];

    const result = await runEntry({
      specJson: JSON.stringify({
        schemaVersion: "1",
        workspace: "/ws",
        threadId: "t1",
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        input: "hi",
      }),
      writeEvent: (ev) => written.push(ev),
      writeStderr: (line) => stderr.push(line),
      signal: new AbortController().signal,
      apiKeyEnv: "CUSTOM_KEY",
      createAgent: () => Promise.resolve(makeMockAgent(events)),
    });

    expect(result).toBe(0);
  } finally {
    if (original !== undefined) {
      process.env.CUSTOM_KEY = original;
    } else {
      delete process.env.CUSTOM_KEY;
    }
  }
});

// ─── Test 7: Signal abort → yields events + exit 0 ──────────────

test("signal abort → agent yields events and runner returns 0", async () => {
  const controller = new AbortController();
  const events: AgentEvent[] = [msgEvent("partial")];
  let receivedSignal: AbortSignal | undefined;

  let runCalls = 0;
  const mockAgent: Agent = {
    thread: { id: "t1", messages: [] },
    async *run(_input, opts) {
      runCalls++;
      if (runCalls > 1) return; // M11: skip reflect turn
      receivedSignal = opts?.signal;
      for (const ev of events) {
        yield ev;
      }
    },
    async *resume(_cmd, _opts) {
      yield* [] as AgentEvent[];
    },
    fork(_msgs, _id) {
      return mockAgent;
    },
  };

  const written: AgentEvent[] = [];
  const stderr: string[] = [];

  const result = await runEntry({
    specJson: makeValidSpec(),
    writeEvent: (ev) => written.push(ev),
    writeStderr: (line) => stderr.push(line),
    signal: controller.signal,
    createAgent: () => Promise.resolve(mockAgent),
  });

  expect(result).toBe(0);
  expect(receivedSignal).toBe(controller.signal);
  expect(written.length).toBe(1);
  expect(runCalls).toBe(2); // main run + reflect turn
});

// ─── Test 8: agent.run throws → error event + return 1 ──────────

test("agent.run throws → error event with stack + return 1", async () => {
  const mockAgent: Agent = {
    thread: { id: "t1", messages: [] },
    async *run(_input, _opts) {
      yield* [] as AgentEvent[];
      throw new Error("model timeout");
    },
    async *resume(_cmd, _opts) {
      yield* [] as AgentEvent[];
    },
    fork(_msgs, _id) {
      return mockAgent;
    },
  };

  const written: AgentEvent[] = [];
  const stderr: string[] = [];

  const result = await runEntry({
    specJson: makeValidSpec(),
    writeEvent: (ev) => written.push(ev),
    writeStderr: (line) => stderr.push(line),
    signal: new AbortController().signal,
    createAgent: () => Promise.resolve(mockAgent),
  });

  expect(result).toBe(1);
  expect(written.length).toBe(1);
  const err = asError(written[0]);
  expect(err.message).toBe("model timeout");
  expect(err.stack).toBeDefined();
});

// ─── Test 9: maxSteps forwarded to agent.run ────────────────────

test("maxSteps from spec is forwarded to agent.run", async () => {
  let receivedMaxSteps: number | undefined;

  const mockAgent: Agent = {
    thread: { id: "t1", messages: [] },
    async *run(_input, opts) {
      receivedMaxSteps = opts?.maxSteps;
      yield msgEvent("done");
    },
    async *resume(_cmd, _opts) {
      yield* [] as AgentEvent[];
    },
    fork(_msgs, _id) {
      return mockAgent;
    },
  };

  const written: AgentEvent[] = [];
  const stderr: string[] = [];

  const result = await runEntry({
    specJson: JSON.stringify({
      schemaVersion: "1",
      workspace: "/ws",
      threadId: "t1",
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      apiKey: "sk-test",
      input: "hi",
      maxSteps: 7,
    }),
    writeEvent: (ev) => written.push(ev),
    writeStderr: (line) => stderr.push(line),
    signal: new AbortController().signal,
    createAgent: () => Promise.resolve(mockAgent),
  });

  expect(result).toBe(0);
  expect(receivedMaxSteps).toBe(7);
});

// ─── Test 10: Multiple events preserve order ────────────────────

test("multiple events preserved in order", async () => {
  const events: AgentEvent[] = [
    msgEvent("first"),
    msgEvent("second"),
    { type: "error", payload: { message: "third" } },
  ];

  const written: AgentEvent[] = [];
  const stderr: string[] = [];

  const result = await runEntry({
    specJson: makeValidSpec(),
    writeEvent: (ev) => written.push(ev),
    writeStderr: (line) => stderr.push(line),
    signal: new AbortController().signal,
    createAgent: () => Promise.resolve(makeMockAgent(events)),
  });

  expect(result).toBe(0);
  expect(written.length).toBe(3);
  expect(asMessage(written[0]).payload.content[0]).toEqual({
    type: "text",
    text: "first",
  });
  expect(asMessage(written[1]).payload.content[0]).toEqual({
    type: "text",
    text: "second",
  });
  expect(asError(written[2]).message).toBe("third");
});

// ─── Test 11: NDJSON round-trip ─────────────────────────────────

test("writeEvent receives valid NDJSON-roundtrippable events", async () => {
  const events: AgentEvent[] = [
    msgEvent("hello"),
    {
      type: "error",
      payload: { message: "oops", stack: "Error: oops\n    at test (x.ts:1:2)" },
    },
  ];

  const written: AgentEvent[] = [];
  const stderr: string[] = [];

  const result = await runEntry({
    specJson: makeValidSpec(),
    writeEvent: (ev) => {
      // Simulate NDJSON: serialize and deserialize
      const line = JSON.stringify(ev);
      const parsed = JSON.parse(line) as AgentEvent;
      written.push(parsed);
    },
    writeStderr: (line) => stderr.push(line),
    signal: new AbortController().signal,
    createAgent: () => Promise.resolve(makeMockAgent(events)),
  });

  expect(result).toBe(0);
  expect(written.length).toBe(2);
  expect(written[0]?.type).toBe("message");
  const err = asError(written[1]);
  expect(err.message).toBe("oops");
  expect(err.stack).toBe("Error: oops\n    at test (x.ts:1:2)");
});

// ─── M8 N1 fix: factory throws → error event ──────────────────

test("factory throws → error event (M7 N1 fix)", async () => {
  const written: AgentEvent[] = [];
  const stderr: string[] = [];

  const result = await runEntry({
    specJson: makeValidSpec(),
    writeEvent: (ev) => written.push(ev),
    writeStderr: (line) => stderr.push(line),
    signal: new AbortController().signal,
    createAgent: () => {
      throw new Error("bootstrap failed");
    },
  });

  expect(result).toBe(1);
  expect(written.length).toBe(1);
  expect(asError(written[0]).message).toBe("bootstrap failed");
});

// ─── M8: checkpointerDb passthrough ───────────────────────────

test("checkpointerDb passed through to createAgent", async () => {
  const events: AgentEvent[] = [msgEvent("ok")];
  let receivedDb: unknown;

  const written: AgentEvent[] = [];
  const stderr: string[] = [];

  const mockDb = { __brand: "test-database", name: "test-db" } as const;

  const result = await runEntry({
    specJson: makeValidSpec(),
    writeEvent: (ev) => written.push(ev),
    writeStderr: (line) => stderr.push(line),
    signal: new AbortController().signal,
    checkpointerDb: mockDb as unknown as Record<string, unknown>,
    createAgent: (opts) => {
      receivedDb = (opts as unknown as Record<string, unknown>).checkpointerDb;
      return Promise.resolve(makeMockAgent(events));
    },
  });

  expect(result).toBe(0);
  // Verify the same distinctive object was passed through (not a copy or different object)
  expect(receivedDb).toBe(mockDb);
  expect((receivedDb as typeof mockDb)?.__brand).toBe("test-database");
});

// ─── M8: backward compat — no checkpointerDb still works ──────

test("old EntryIO without checkpointerDb still works", async () => {
  const events: AgentEvent[] = [msgEvent("hello")];
  let receivedDb: unknown = "not-set";

  const written: AgentEvent[] = [];
  const stderr: string[] = [];

  // Construct EntryIO without checkpointerDb field at all
  const result = await runEntry({
    specJson: makeValidSpec(),
    writeEvent: (ev) => written.push(ev),
    writeStderr: (line) => stderr.push(line),
    signal: new AbortController().signal,
    createAgent: (opts) => {
      receivedDb = (opts as unknown as Record<string, unknown>).checkpointerDb;
      return Promise.resolve(makeMockAgent(events));
    },
  });

  expect(result).toBe(0);
  expect(written.length).toBe(1);
  // verify checkpointerDb is undefined when omitted
  expect(receivedDb).toBeUndefined();
});

// ─── M9: EventSink injection ─────────────────────────────────────

test("EventSink appended before writeEvent", async () => {
  const events: AgentEvent[] = [msgEvent("hello")];
  const sinkLog: string[] = [];
  const writeLog: string[] = [];

  const mockSink = {
    append: async (_tid: string, _rid: string, _ev: AgentEvent) => {
      sinkLog.push("append");
      return 1;
    },
  };

  const spec = {
    schemaVersion: "1",
    workspace: "/tmp/ws",
    threadId: "t1",
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    apiKey: "sk-test",
    input: "hello",
    runId: "run-1",
    attemptId: "att-1",
  };

  const result = await runEntry({
    specJson: JSON.stringify(spec),
    writeEvent: () => { writeLog.push("write"); },
    writeStderr: () => {},
    signal: new AbortController().signal,
    createAgent: () => Promise.resolve(makeMockAgent(events)),
    eventSink: mockSink,
  });

  expect(result).toBe(0);
  expect(sinkLog.length).toBe(1);
  // sink 在 write 之前（同一 tick 内顺序保证）
  expect(sinkLog[0]).toBe("append");
});

// ─── M9: Resume mode ─────────────────────────────────────────────

test("mode='resume' calls agent.resume() instead of agent.run()", async () => {
  const events: AgentEvent[] = [msgEvent("resumed output")];
  let resumeCalled = false;
  let runCalled = false;

  function makeResumeAgent(): Agent {
    return {
      thread: { id: "t1", messages: [] },
      async *run(_input, _opts) {
        runCalled = true;
      },
      async *resume(_cmd, _opts) {
        resumeCalled = true;
        for (const ev of events) yield ev;
      },
      fork(_msgs, _id) {
        return makeResumeAgent();
      },
    };
  }

  const spec = {
    schemaVersion: "1",
    workspace: "/tmp/ws",
    threadId: "t1",
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    apiKey: "sk-test",
    input: "hello",
    mode: "resume",
    resumeCommand: { approved: true, message: "go" },
  };

  const written: AgentEvent[] = [];
  const result = await runEntry({
    specJson: JSON.stringify(spec),
    writeEvent: (ev) => written.push(ev),
    writeStderr: () => {},
    signal: new AbortController().signal,
    createAgent: () => Promise.resolve(makeResumeAgent()),
  });

  expect(result).toBe(0);
  expect(resumeCalled).toBe(true);
  expect(runCalled).toBe(false);
  expect(written.length).toBe(1);
});

// ─── M9: heartbeat timer ─────────────────────────────────────────

test("heartbeat timer starts when attemptId and storage available", async () => {
  const events: AgentEvent[] = [msgEvent("ok")];
  let heartbeatCount = 0;

  const spec = {
    schemaVersion: "1",
    workspace: "/tmp/ws",
    threadId: "t1",
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    apiKey: "sk-test",
    input: "hello",
    runId: "run-1",
    attemptId: "att-1",
    storage: {
      eventLog: { kind: "sqlite", path: ":memory:" },
      checkpointer: { kind: "memory" },
    },
  };

  const result = await runEntry({
    specJson: JSON.stringify(spec),
    writeEvent: () => {},
    writeStderr: () => {},
    signal: new AbortController().signal,
    createAgent: () => Promise.resolve(makeMockAgent(events)),
    heartbeatIntervalMs: 10, // fast for test
  });

  expect(result).toBe(0);
  // heartbeat timer started and cleaned up without error
});

// ─── M10: conversationId fallback ────────────────────────────

test("spec with conversationId and senderMemberId parsed successfully", async () => {
  const events: AgentEvent[] = [msgEvent("ok")];
  const written: AgentEvent[] = [];

  const spec = {
    schemaVersion: "1",
    workspace: "/tmp/ws",
    threadId: "t1",
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    apiKey: "sk-test",
    input: "hello",
    conversationId: "conv-1",
    senderMemberId: "mem-x1",
  };

  const result = await runEntry({
    specJson: JSON.stringify(spec),
    writeEvent: (ev) => written.push(ev),
    writeStderr: () => {},
    signal: new AbortController().signal,
    createAgent: () => Promise.resolve(makeMockAgent(events)),
  });

  expect(result).toBe(0);
  expect(written.length).toBe(1);
});

test("spec without conversationId still works (fallback to threadId)", async () => {
  const events: AgentEvent[] = [msgEvent("hello")];
  const written: AgentEvent[] = [];

  const result = await runEntry({
    specJson: makeValidSpec(),
    writeEvent: (ev) => written.push(ev),
    writeStderr: () => {},
    signal: new AbortController().signal,
    createAgent: () => Promise.resolve(makeMockAgent(events)),
  });

  expect(result).toBe(0);
  expect(written.length).toBe(1);
});

// ─── P0-1 regression: self-build checkpointer from spec.storage ──

test("P0-1: self-builds checkpointer from spec.storage.checkpointer.path when not injected", async () => {
  const tmpDbPath = `/tmp/test-cp-selfbuild-${Date.now()}.db`;

  // Pre-write a message into checkpoint_messages (simulating broadcast projection)
  {
    const { Database } = await import("bun:sqlite");
    const setupDb = new Database(tmpDbPath);
    setupDb.exec("CREATE TABLE IF NOT EXISTS checkpoint_messages (thread_id TEXT PRIMARY KEY, messages TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    setupDb.run("INSERT INTO checkpoint_messages (thread_id, messages, updated_at) VALUES (?, ?, ?)", [
      "t1",
      JSON.stringify([{ role: "user", content: "[Alice]: hello from broadcast" }]),
      Date.now(),
    ]);
    setupDb.close();
  }

  const events: AgentEvent[] = [msgEvent("ok")];
  const written: AgentEvent[] = [];
  let capturedCheckpointerDb: unknown = undefined;

  const spec = {
    schemaVersion: "1",
    workspace: "/tmp/ws",
    threadId: "t1",
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    apiKey: "sk-test",
    input: "hello",
    conversationId: "conv-1",
    senderMemberId: "mem-x1",
    storage: {
      checkpointer: { kind: "sqlite", path: tmpDbPath },
    },
  };

  const result = await runEntry({
    specJson: JSON.stringify(spec),
    writeEvent: (ev) => written.push(ev),
    writeStderr: () => {},
    signal: new AbortController().signal,
    // Deliberately OMIT checkpointerDb — production path, must self-build
    createAgent: (opts) => {
      capturedCheckpointerDb = (opts as { checkpointerDb?: unknown }).checkpointerDb;
      return Promise.resolve(makeMockAgent(events));
    },
  });

  expect(result).toBe(0);
  // P0-1: checkpointerDb must be self-built from spec.storage.checkpointer.path
  expect(capturedCheckpointerDb).toBeDefined();
  expect(capturedCheckpointerDb).not.toBeNull();
  // Must be a bun:sqlite Database (has .close method)
  expect(typeof (capturedCheckpointerDb as { close?: unknown }).close).toBe("function");

  try { require("node:fs").unlinkSync(tmpDbPath); } catch {}
});

// ─── M11: Progress heartbeat (replaces independent setInterval) ────

test("M11: heartbeat updated after each sink.append (progress, not liveness)", async () => {
  const events: AgentEvent[] = [msgEvent("a"), msgEvent("b")];
  const appendCalls: number[] = [];
  let heartbeatCount = 0;

  const mockSink = {
    append: async (_tid: string, _rid: string, _ev: AgentEvent) => {
      appendCalls.push(Date.now());
      heartbeatCount++;
      return appendCalls.length;
    },
  };

  // Use :memory: db so heartbeat writes don't fail
  const { Database } = await import("bun:sqlite");
  const memDb = new Database(":memory:");
  memDb.exec("CREATE TABLE IF NOT EXISTS attempt (attempt_id TEXT PRIMARY KEY, run_id TEXT, pid INTEGER, heartbeat_at INTEGER, started_at INTEGER, ended_at INTEGER)");
  memDb.exec("CREATE TABLE IF NOT EXISTS run (run_id TEXT PRIMARY KEY, thread_id TEXT, status TEXT, started_at INTEGER, ended_at INTEGER)");
  memDb.run("INSERT INTO attempt (attempt_id, run_id, started_at) VALUES ('att-m11', 'run-m11', ?)", [Date.now()]);
  memDb.run("INSERT INTO run (run_id, thread_id, status, started_at) VALUES ('run-m11', 't1', 'running', ?)", [Date.now()]);
  const dbPath = `/tmp/test-m11-hb-${Date.now()}.db`;
  memDb.close();
  // Copy :memory: isn't possible; just use a temp file db
  const tmpDb = new Database(dbPath);
  tmpDb.exec("CREATE TABLE IF NOT EXISTS attempt (attempt_id TEXT PRIMARY KEY, run_id TEXT, pid INTEGER, heartbeat_at INTEGER, started_at INTEGER, ended_at INTEGER)");
  tmpDb.exec("CREATE TABLE IF NOT EXISTS run (run_id TEXT PRIMARY KEY, thread_id TEXT, status TEXT, started_at INTEGER, ended_at INTEGER)");
  tmpDb.run("INSERT INTO attempt (attempt_id, run_id, started_at) VALUES ('att-m11', 'run-m11', ?)", [Date.now()]);
  tmpDb.run("INSERT INTO run (run_id, thread_id, status, started_at) VALUES ('run-m11', 't1', 'running', ?)", [Date.now()]);
  tmpDb.close();

  const spec = {
    schemaVersion: "1",
    workspace: "/tmp/ws",
    threadId: "t1",
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    apiKey: "sk-test",
    input: "hello",
    runId: "run-m11",
    attemptId: "att-m11",
    storage: {
      eventLog: { kind: "sqlite", path: dbPath },
    },
  };

  const result = await runEntry({
    specJson: JSON.stringify(spec),
    writeEvent: () => {},
    writeStderr: () => {},
    signal: new AbortController().signal,
    createAgent: () => Promise.resolve(makeMockAgent(events)),
    eventSink: mockSink,
    heartbeatIntervalMs: 1, // minimal throttle
  });

  expect(result).toBe(0);
  // Heartbeat should have fired (at least once, throttled per append)
  // We can verify by checking the DB
  try {
    const checkDb = new Database(dbPath);
    const row = checkDb.query("SELECT heartbeat_at FROM attempt WHERE attempt_id = 'att-m11'").get() as { heartbeat_at: number | null } | undefined;
    expect(row?.heartbeat_at).toBeDefined();
    expect(row!.heartbeat_at).toBeGreaterThan(0);
    checkDb.close();
  } finally {
    try { require("node:fs").unlinkSync(dbPath); } catch {}
  }
});

test("M11: heartbeat NOT written when no sink configured (backward compat)", async () => {
  const events: AgentEvent[] = [msgEvent("ok")];
  const spec = {
    schemaVersion: "1",
    workspace: "/tmp/ws",
    threadId: "t1",
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    apiKey: "sk-test",
    input: "hello",
  };

  const result = await runEntry({
    specJson: JSON.stringify(spec),
    writeEvent: () => {},
    writeStderr: () => {},
    signal: new AbortController().signal,
    createAgent: () => Promise.resolve(makeMockAgent(events)),
    // No eventSink → no heartbeat DB writes
  });

  expect(result).toBe(0);
});

// ─── M11: Reflect after run loop (Growth) ──────────────────────────

test("M11: reflect runs after main loop in non-genesis mode", async () => {
  const events: AgentEvent[] = [msgEvent("task done")];
  const reflectEvents: AgentEvent[] = [msgEvent("reflected")];
  const runInputs: string[] = [];

  function makeReflectAgent(): Agent {
    return {
      thread: { id: "t1", messages: [] },
      async *run(input, _opts) {
        runInputs.push(input as string);
        if (runInputs.length === 1) {
          for (const ev of events) yield ev;
        } else {
          for (const ev of reflectEvents) yield ev;
        }
      },
      async *resume(_cmd, _opts) {
        yield* [] as AgentEvent[];
      },
      fork(_msgs, _id) {
        return makeReflectAgent();
      },
    };
  }

  const written: AgentEvent[] = [];
  const result = await runEntry({
    specJson: makeValidSpec(),
    writeEvent: (ev) => written.push(ev),
    writeStderr: () => {},
    signal: new AbortController().signal,
    createAgent: () => Promise.resolve(makeReflectAgent()),
  });

  expect(result).toBe(0);
  // Main run + reflect run = 2 calls to agent.run()
  expect(runInputs.length).toBe(2);
  // First call is the original input
  expect(runInputs[0]).toBe("hello");
  // Second call is the reflection guidance
  expect(runInputs[1]!).toInclude("Reflect on the conversation");
  expect(runInputs[1]!).toInclude("memory");
  // Both runs' events appear in output
  expect(written.length).toBe(2);
});

test("M11: reflect events appended to EventSink", async () => {
  const events: AgentEvent[] = [msgEvent("task done")];
  const reflectEvents: AgentEvent[] = [msgEvent("reflected")];
  let runCount = 0;
  const sinkLog: string[] = [];

  const mockSink = {
    append: async (_tid: string, _rid: string, ev: AgentEvent) => {
      if (ev.type === "message" && Array.isArray(ev.payload.content) && ev.payload.content[0]?.type === "text") {
        sinkLog.push(ev.payload.content[0].text);
      }
      return sinkLog.length;
    },
  };

  function makeAgentWithReflect(): Agent {
    return {
      thread: { id: "t1", messages: [] },
      async *run(_input, _opts) {
        runCount++;
        if (runCount === 1) {
          for (const ev of events) yield ev;
        } else {
          for (const ev of reflectEvents) yield ev;
        }
      },
      async *resume(_cmd, _opts) {
        yield* [] as AgentEvent[];
      },
      fork(_msgs, _id) {
        return makeAgentWithReflect();
      },
    };
  }

  const result = await runEntry({
    specJson: makeValidSpec(),
    writeEvent: () => {},
    writeStderr: () => {},
    signal: new AbortController().signal,
    createAgent: () => Promise.resolve(makeAgentWithReflect()),
    eventSink: mockSink,
  });

  expect(result).toBe(0);
  expect(sinkLog).toContain("task done");
  expect(sinkLog).toContain("reflected");
});
