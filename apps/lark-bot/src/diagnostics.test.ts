import { describe, expect, test } from "bun:test";
import { collectHealth, heartbeatPayload, type LarkBotHealth } from "./diagnostics.js";

const HEALTH: LarkBotHealth = {
  agentId: "a1",
  profileRef: "agent:a1",
  status: "running",
  watchers: { conversation: 2, runDelta: 1 },
  runStreams: {
    starting: 0,
    streaming: 0,
    done: 0,
    error: 0,
    fallbackText: 0,
    cardSendFailed: 0,
    cardUpdateFailed: 0,
  },
  lastError: null,
  pendingDeliveries: 3,
  ts: 1_800_000_000_000,
};

describe("heartbeat payload", () => {
  test("carries pendingDeliveries — the whitelist is not the health object", () => {
    // The wire body is an explicit whitelist, so a field on LarkBotHealth
    // reaches the backend only if it is named here. It was omitted once and
    // the surface view read the queue as permanently empty.
    const payload = heartbeatPayload(HEALTH);
    expect(payload.pendingDeliveries).toBe(3);
    expect(Object.keys(payload).sort()).toEqual(
      ["pendingDeliveries", "profileRef", "runStreams", "ts", "watchers"].sort(),
    );
  });

  test("reporting a queue is a flat number the backend can flatten", () => {
    // The backend lifts top-level numbers into counters; a nested object
    // would silently never appear as a counter.
    expect(typeof heartbeatPayload(HEALTH).pendingDeliveries).toBe("number");
  });
});

describe("collectHealth", () => {
  test("degraded iff there is a lastError, and it reports the pending queue", () => {
    const clean = collectHealth("a1", "agent:a1", { conversation: 2, runDelta: 0 }, null, 0);
    expect(clean.status).toBe("running");
    expect(clean.pendingDeliveries).toBe(0);

    const sad = collectHealth("a1", "agent:a1", { conversation: 2, runDelta: 0 }, "boom", 7);
    expect(sad.status).toBe("degraded");
    expect(sad.lastError).toBe("boom");
    expect(sad.pendingDeliveries).toBe(7);
  });
});
