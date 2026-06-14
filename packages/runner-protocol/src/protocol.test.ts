import { describe, expect, test } from "bun:test";
import { createMemoryTransportPair } from "./memory-transport.js";
import { createFramer, encode } from "./ndjson.js";
import { createSocketClient } from "./socket-transport.js";

// ─── NDJSON framer ───

describe("createFramer", () => {
  test("decodes a single complete frame", () => {
    const msgs: unknown[] = [];
    const bad: string[] = [];
    const framer = createFramer(
      (obj) => msgs.push(obj),
      (line) => bad.push(line),
    );

    framer.feed(`${JSON.stringify({ type: "start", runId: "r1" })}\n`);

    expect(msgs).toEqual([{ type: "start", runId: "r1" }]);
    expect(bad).toEqual([]);
  });

  test("decodes multiple frames in a single chunk (stick)", () => {
    const msgs: unknown[] = [];
    const framer = createFramer(
      (obj) => msgs.push(obj),
      () => {},
    );

    framer.feed(
      encode({ type: "event", runId: "r1" }) + encode({ type: "heartbeat", runId: "r1" }),
    );

    expect(msgs).toEqual([
      { type: "event", runId: "r1" },
      { type: "heartbeat", runId: "r1" },
    ]);
  });

  test("reassembles partial frame across chunks (half-frame)", () => {
    const msgs: unknown[] = [];
    const framer = createFramer(
      (obj) => msgs.push(obj),
      () => {},
    );

    const full = encode({ type: "run_done", runId: "r1", status: "succeeded" });
    const split = Math.floor(full.length / 2);

    framer.feed(full.slice(0, split));
    expect(msgs).toEqual([]); // not complete yet

    framer.feed(full.slice(split));
    expect(msgs).toEqual([{ type: "run_done", runId: "r1", status: "succeeded" }]);
  });

  test("skips empty lines", () => {
    const msgs: unknown[] = [];
    const framer = createFramer(
      (obj) => msgs.push(obj),
      () => {},
    );

    framer.feed(`\n\n${encode({ type: "heartbeat", runId: "r1" })}\n\n`);

    expect(msgs).toEqual([{ type: "heartbeat", runId: "r1" }]);
  });

  test("calls onBadFrame for malformed JSON", () => {
    const bad: string[] = [];
    const framer = createFramer(
      () => {},
      (line) => bad.push(line),
    );

    framer.feed("not json at all\n");

    expect(bad).toEqual(["not json at all"]);
  });

  test("throws after maxBadFrames consecutive bad frames", () => {
    const framer = createFramer(
      () => {},
      () => {},
      3,
    );

    framer.feed("bad1\nbad2\n");
    // third bad frame should throw
    expect(() => framer.feed("bad3\n")).toThrow("consecutive bad frames");
  });

  test("resets bad count on successful frame", () => {
    const msgs: unknown[] = [];
    const framer = createFramer(
      (obj) => msgs.push(obj),
      () => {},
      3,
    );

    framer.feed("bad1\nbad2\n");
    framer.feed(`${encode({ ok: true })}\n`); // success resets
    framer.feed("bad3\nbad4\n"); // counter restarted

    // should not throw yet (only 2 consecutive since last success)
    expect(msgs).toEqual([{ ok: true }]);
  });

  test("handles Uint8Array chunks", () => {
    const msgs: unknown[] = [];
    const framer = createFramer(
      (obj) => msgs.push(obj),
      () => {},
    );

    const enc = new TextEncoder();
    framer.feed(enc.encode(encode({ type: "abort", runId: "r1" })));

    expect(msgs).toEqual([{ type: "abort", runId: "r1" }]);
  });
});

// ─── Memory transport ───

describe("createMemoryTransportPair", () => {
  test("host → runner delivery", () => {
    const { host, runner } = createMemoryTransportPair();
    const received: unknown[] = [];

    runner.onMessage((msg) => received.push(msg));
    host.send({ type: "start", runId: "r1", spec: {} });

    expect(received).toEqual([{ type: "start", runId: "r1", spec: {} }]);
  });

  test("runner → host delivery", () => {
    const { host, runner } = createMemoryTransportPair();
    const received: unknown[] = [];

    host.onMessage((msg) => received.push(msg));
    runner.send({ type: "run_done", runId: "r1", status: "succeeded" });

    expect(received).toEqual([{ type: "run_done", runId: "r1", status: "succeeded" }]);
  });

  test("bidirectional exchange", () => {
    const { host, runner } = createMemoryTransportPair();
    const hostReceived: unknown[] = [];
    const runnerReceived: unknown[] = [];

    host.onMessage((msg) => hostReceived.push(msg));
    runner.onMessage((msg) => runnerReceived.push(msg));

    host.send({ type: "start", runId: "r1", spec: {} });
    runner.send({
      type: "run_started",
      runId: "r1",
      parentRunId: "",
      threadId: "t1",
      kind: "reflect",
      spec: { agentId: "ag-test", mode: "reflect" },
    });
    runner.send({ type: "heartbeat", runId: "r1" });

    expect(runnerReceived.length).toBe(1);
    expect(hostReceived.length).toBe(2);
  });

  test("messages sent before listener are still delivered (queued)", () => {
    const { host, runner } = createMemoryTransportPair();

    host.send({ type: "start", runId: "r1", spec: {} });

    const received: unknown[] = [];
    // Listener registered AFTER send — queued messages drain on register
    runner.onMessage((msg) => received.push(msg));

    expect(received).toEqual([{ type: "start", runId: "r1", spec: {} }]);
  });

  test("close prevents further delivery", () => {
    const { host, runner } = createMemoryTransportPair();
    const received: unknown[] = [];

    runner.onMessage((msg) => received.push(msg));

    host.close();
    host.send({ type: "start", runId: "r1", spec: {} });

    expect(received).toEqual([]);
  });

  test("onClose fires when transport closes", () => {
    const { host } = createMemoryTransportPair();
    let closed = false;

    host.onClose(() => {
      closed = true;
    });
    host.close();

    expect(closed).toBe(true);
  });

  // Checkpointer RPC tests removed — checkpoint is now handled locally
  // by SQLiteCheckpointer via runner-state volume, not over Transport.
});

// ─── ready() timeout ───

describe("SocketClient ready()", () => {
  test("memory transport ready() resolves immediately", async () => {
    const { host } = createMemoryTransportPair();
    await expect(host.ready()).resolves.toBeUndefined();
  });

  test("socket client ready() rejects on timeout for non-existent socket", async () => {
    const client = createSocketClient({
      socketPath: `/tmp/no-such-socket-${crypto.randomUUID()}`,
      readyTimeoutMs: 200,
    });
    await expect(client.ready()).rejects.toThrow("transport ready timeout");
    client.close();
  });

  test("socket client ready() does not reject when connect succeeds", async () => {
    // Use a real Bun.listen socket to test successful connection
    const socketPath = `/tmp/test-ready-${crypto.randomUUID()}`;
    const server = Bun.listen({ unix: socketPath, socket: { data() {} } });
    try {
      const client = createSocketClient({ socketPath, readyTimeoutMs: 5000 });
      await expect(client.ready()).resolves.toBeUndefined();
      client.close();
    } finally {
      server.stop();
    }
  });
});
