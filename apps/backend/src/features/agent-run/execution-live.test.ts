import { describe, expect, test } from "bun:test";
import type { BackendEvent } from "@chengchenccc/agent-contract";
import { createLiveEventBus } from "./execution-live.js";

/** A controllable durable hook: the test decides when persistence "completes". */
function deferredHook() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, done: resolve };
}

const approvalEvent: BackendEvent = {
  type: "backend.oma.approval_request",
  payload: { callId: "call-1", toolName: "bash" },
} as BackendEvent;

describe("createLiveEventBus durable HITL ordering", () => {
  test("an approval reaches subscribers only after the durable hook resolves", async () => {
    const gate = deferredHook();
    let persisted = false;
    const bus = createLiveEventBus({
      onApprovalRequest: async () => {
        await gate.promise;
        persisted = true;
      },
    });
    const seen: BackendEvent[] = [];
    const sub = bus.subscribe("r1");
    const reading = (async () => {
      for await (const ev of sub) seen.push(ev);
    })();

    // Fire-and-forget on purpose: the broadcast must not deliver until the gate opens.
    void bus.broadcast("r1", approvalEvent);
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([]); // the card is NOT out yet
    gate.done();
    await new Promise((r) => setTimeout(r, 30));
    expect(persisted).toBe(true);
    expect(seen.map((e) => e.type)).toEqual(["backend.oma.approval_request"]);
    void reading;
  });

  test("a persistence failure drops the event - no dead card", async () => {
    const bus = createLiveEventBus({
      onApprovalRequest: async () => {
        throw new Error("sqlite is on fire");
      },
    });
    const seen: BackendEvent[] = [];
    const sub = bus.subscribe("r2");
    const reading = (async () => {
      for await (const ev of sub) seen.push(ev);
    })();

    await bus.broadcast("r2", approvalEvent); // must not throw, must not deliver
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([]);
    void reading;
  });

  test("non-approval events pass straight through (no hook involved)", async () => {
    let hookCalls = 0;
    const bus = createLiveEventBus({
      onApprovalRequest: async () => {
        hookCalls += 1;
      },
    });
    const seen: BackendEvent[] = [];
    const reading = (async () => {
      for await (const ev of bus.subscribe("r3")) seen.push(ev);
    })();
    await bus.broadcast("r3", { type: "status", status: "running" });
    await new Promise((r) => setTimeout(r, 30));
    expect(seen.map((e) => e.type)).toEqual(["status"]);
    expect(hookCalls).toBe(0);
    void reading;
  });
});
