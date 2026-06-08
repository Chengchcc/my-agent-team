import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import type { Agent, AgentEvent } from "@my-agent-team/framework";
import { runEntry } from "./entry";
import * as fs from "node:fs";

const tmpFiles: string[] = [];

function tmpPath(): string {
  const p = `/tmp/test-m9-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  tmpFiles.push(p);
  return p;
}

afterAll(() => {
  for (const p of tmpFiles) {
    try { fs.unlinkSync(p); } catch {}
    try { fs.unlinkSync(p + "-wal"); } catch {}
    try { fs.unlinkSync(p + "-shm"); } catch {}
  }
});

function msgEvent(text: string): AgentEvent {
  return { type: "message", payload: { role: "assistant", content: [{ type: "text", text }] } };
}

function makeMockAgent(events: AgentEvent[]): Agent {
  let runCalls = 0;
  return {
    thread: { id: "t1", messages: [] },
    async *run(_input, _opts) {
      runCalls++;
      // M11: second call is reflect turn — yield nothing by default
      if (runCalls > 1) return;
      for (const ev of events) yield ev;
    },
    async *resume(_cmd, _opts) { yield* [] as AgentEvent[]; },
    fork(_msgs, _id) { return makeMockAgent([]); }, // M11: fork yields nothing by default
  };
}

// ── FIX-2: real fork e2e — production path (no injected EventSink) ──

test("FIX-2: production path — self-built EventSink writes to event_log", async () => {
  const dbPath = tmpPath();
  const events: AgentEvent[] = [msgEvent("e1"), msgEvent("e2"), msgEvent("e3")];

  const spec = {
    schemaVersion: "1" as const,
    workspace: "/tmp/ws",
    threadId: "t1",
    model: { provider: "anthropic" as const, model: "claude-sonnet-4-6" },
    apiKey: "sk-test",
    input: "hello",
    runId: "run-e2e-1",
    attemptId: "att-e2e-1",
    storage: {
      eventLog: { kind: "sqlite" as const, path: dbPath },
      checkpointer: { kind: "memory" as const },
    },
  };

  const result = await runEntry({
    specJson: JSON.stringify(spec),
    writeEvent: () => {},
    writeStderr: () => {},
    signal: new AbortController().signal,
    createAgent: () => Promise.resolve(makeMockAgent(events)),
    // NOTE: no eventSink injected — this is the production path
  });

  expect(result).toBe(0);

  // Verify events landed in event_log
  using db = new Database(dbPath);
  const rows = db.query("SELECT seq, thread_id, run_id, event, ts FROM event_log ORDER BY seq").all() as {
    seq: number; thread_id: string; run_id: string; event: string; ts: number;
  }[];

  expect(rows.length).toBe(3);
  expect(rows[0]!.seq).toBe(1);
  expect(rows[1]!.seq).toBe(2);
  expect(rows[2]!.seq).toBe(3);
  expect(rows[0]!.run_id).toBe("run-e2e-1");
  expect(rows[0]!.thread_id).toBe("t1");

  // Verify events are valid JSON AgentEvent
  for (const row of rows) {
    const ev = JSON.parse(row.event);
    expect(ev.type).toBe("message");
  }
});

// ── Cold read: subscribe replays events after run completes ──

test("FIX-2: cold read — EventLog.subscribe replays all events + completes", async () => {
  const dbPath = tmpPath();
  const events: AgentEvent[] = [msgEvent("cold-1"), msgEvent("cold-2")];

  const spec = {
    schemaVersion: "1" as const,
    workspace: "/tmp/ws",
    threadId: "t2",
    model: { provider: "anthropic" as const, model: "claude-sonnet-4-6" },
    apiKey: "sk-test",
    input: "hello",
    runId: "run-cold-1",
    attemptId: "att-cold-1",
    storage: {
      eventLog: { kind: "sqlite" as const, path: dbPath },
      checkpointer: { kind: "memory" as const },
    },
  };

  // Run the agent (events written by self-built EventSink)
  await runEntry({
    specJson: JSON.stringify(spec),
    writeEvent: () => {},
    writeStderr: () => {},
    signal: new AbortController().signal,
    createAgent: () => Promise.resolve(makeMockAgent(events)),
  });

  // Cold read: open a fresh EventLog and subscribe
  const { sqliteEventLog } = await import("@my-agent-team/event-log");
  const eventLog = sqliteEventLog({ db: dbPath });
  const ac = new AbortController();

  const collected: unknown[] = [];
  const sub = eventLog.subscribe({ runId: "run-cold-1" }, { pollMs: 50 }, ac.signal);

  // Collect for a short time (events already written, should replay immediately)
  const timer = setTimeout(() => ac.abort(), 500);
  for await (const rec of sub) {
    collected.push(rec);
    if (collected.length >= 2) ac.abort();
  }
  clearTimeout(timer);

  expect(collected.length).toBe(2);
  // @ts-expect-error seq property
  expect(collected[0]!.seq).toBe(1);
  // @ts-expect-error seq property
  expect(collected[1]!.seq).toBe(2);
});

// ── seq monotonicity across multiple appends ──

test("FIX-2: seq is monotonically increasing", async () => {
  const dbPath = tmpPath();
  const events: AgentEvent[] = Array.from({ length: 10 }, (_, i) => msgEvent(`msg${i}`));

  const spec = {
    schemaVersion: "1" as const,
    workspace: "/tmp/ws",
    threadId: "t3",
    model: { provider: "anthropic" as const, model: "claude-sonnet-4-6" },
    apiKey: "sk-test",
    input: "hello",
    runId: "run-seq-1",
    attemptId: "att-seq-1",
    storage: {
      eventLog: { kind: "sqlite" as const, path: dbPath },
      checkpointer: { kind: "memory" as const },
    },
  };

  await runEntry({
    specJson: JSON.stringify(spec),
    writeEvent: () => {},
    writeStderr: () => {},
    signal: new AbortController().signal,
    createAgent: () => Promise.resolve(makeMockAgent(events)),
  });

  using db = new Database(dbPath);
  const rows = db.query("SELECT seq FROM event_log WHERE run_id = ? ORDER BY seq").all("run-seq-1") as { seq: number }[];

  expect(rows.length).toBe(10);
  for (let i = 0; i < rows.length; i++) {
    expect(rows[i]!.seq).toBe(i + 1);
  }
});

// ── Regression: without FIX-1, events are NOT written ──

test("FIX-2: regression guard — events land in DB even without explicit eventSink injection", async () => {
  const dbPath = tmpPath();
  const events: AgentEvent[] = [msgEvent("guard-test")];

  const spec = {
    schemaVersion: "1" as const,
    workspace: "/tmp/ws",
    threadId: "t4",
    model: { provider: "anthropic" as const, model: "claude-sonnet-4-6" },
    apiKey: "sk-test",
    input: "hello",
    runId: "run-guard-1",
    attemptId: "att-guard-1",
    storage: {
      eventLog: { kind: "sqlite" as const, path: dbPath },
      checkpointer: { kind: "memory" as const },
    },
  };

  // This is the production path: no eventSink, no checkpointerDb
  await runEntry({
    specJson: JSON.stringify(spec),
    writeEvent: () => {},
    writeStderr: () => {},
    signal: new AbortController().signal,
    createAgent: () => Promise.resolve(makeMockAgent(events)),
  });

  using db = new Database(dbPath);
  const count = (db.query("SELECT COUNT(*) as c FROM event_log").get() as { c: number }).c;

  // If FIX-1 is reverted, count will be 0
  expect(count).toBe(1);
});
