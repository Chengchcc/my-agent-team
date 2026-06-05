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
  return {
    thread: { id: "t1", messages: [] },
    async *run(_input, _opts) {
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

  const mockAgent: Agent = {
    thread: { id: "t1", messages: [] },
    async *run(_input, opts) {
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
