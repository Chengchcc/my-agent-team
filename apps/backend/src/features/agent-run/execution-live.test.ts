import { describe, expect, test } from "bun:test";
import { createLiveEventBus } from "./execution-live.js";
import type { BackendEvent } from "./protocol/index.js";

/** A controllable durable hook: the test decides when persistence "completes". */
function deferredHook() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, done: resolve };
}

const approvalEvent: BackendEvent = {
  type: "approval_requested",
  payload: { callId: "call-1", toolName: "bash" },
} as BackendEvent;

describe("createLiveEventBus durable HITL ordering", () => {
  test("an approval reaches the observer only after the durable hook resolves", async () => {
    const gate = deferredHook();
    let persisted = false;
    const seen: BackendEvent[] = [];
    const bus = createLiveEventBus({
      onLiveEvent: (_runId, ev) => seen.push(ev),
      onApprovalRequest: async () => {
        await gate.promise;
        persisted = true;
      },
    });

    // Fire-and-forget on purpose: the broadcast must not deliver until the gate opens.
    void bus.broadcast("r1", approvalEvent);
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([]); // the card is NOT out yet
    gate.done();
    await new Promise((r) => setTimeout(r, 30));
    expect(persisted).toBe(true);
    expect(seen.map((e) => e.type)).toEqual(["approval_requested"]);
  });

  test("a persistence failure drops the event - no dead card", async () => {
    const seen: BackendEvent[] = [];
    const bus = createLiveEventBus({
      onLiveEvent: (_runId, ev) => seen.push(ev),
      onApprovalRequest: async () => {
        throw new Error("sqlite is on fire");
      },
    });

    await bus.broadcast("r2", approvalEvent); // must not throw, must not deliver
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([]);
  });

  test("HITL events land in the telemetry log (a parked run is not eventless)", async () => {
    // Diagnosed the hard way (2026-09-28): agent_run_event holds no HITL
    // rows, so "no events" read as "nothing happened" while the run sat
    // waiting for a human. The ops view wants the wait too.
    const persisted: string[] = [];
    const bus = createLiveEventBus({
      persistRunEvent: async (_runId, event) => {
        persisted.push(event.type);
      },
      onApprovalRequest: async () => {},
    });
    await bus.broadcast("r-hitl", approvalEvent);
    await bus.broadcast("r-hitl", {
      type: "ask_requested",
      payload: { callId: "call-ask" },
    } as BackendEvent);
    await bus.broadcast("r-hitl", { type: "text_delta", text: "still transient" } as BackendEvent);
    // persistRunEvent is fire-and-forget; let its microtasks drain.
    await Bun.sleep(1);
    expect(persisted).toEqual(["approval_requested", "ask_requested"]);
  });

  test("non-approval events pass straight through (no hook involved)", async () => {
    let hookCalls = 0;
    const seen: BackendEvent[] = [];
    const bus = createLiveEventBus({
      onLiveEvent: (_runId, ev) => seen.push(ev),
      onApprovalRequest: async () => {
        hookCalls += 1;
      },
    });
    await bus.broadcast("r3", { type: "status", status: "running" });
    await new Promise((r) => setTimeout(r, 30));
    expect(seen.map((e) => e.type)).toEqual(["status"]);
    expect(hookCalls).toBe(0);
  });
});
