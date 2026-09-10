import { describe, expect, test } from "bun:test";
import { ExecutionEventBus, type WorkflowEvent } from "./event-bus.js";

function ev(event: string, executionId = "e1", data: unknown = {}): WorkflowEvent {
  return { event, executionId, ts: Date.now(), data };
}

/** Collect events until the stream ends (terminal or unsubscribe). Guards
 *  against a broken consume() that never returns: the race fails first. */
async function collect(stream: AsyncIterable<WorkflowEvent>, cap = 100): Promise<WorkflowEvent[]> {
  const out: WorkflowEvent[] = [];
  for await (const e of stream) {
    out.push(e);
    if (out.length >= cap) break;
  }
  return out;
}

describe("ExecutionEventBus", () => {
  test("subscriber receives events in order, terminal ends the stream", async () => {
    const bus = new ExecutionEventBus();
    const sub = bus.subscribe("e1");
    bus.emit(ev("execution_started"));
    bus.emit(ev("node_started"));
    bus.emit(ev("execution_terminal"));
    bus.emit(ev("after_terminal_should_not_deliver"));
    const got = await Promise.race([
      collect(sub.stream),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("consume never ended")), 2000)),
    ]);
    expect(got.map((e) => e.event)).toEqual([
      "execution_started",
      "node_started",
      "execution_terminal",
    ]);
  });

  test("events emitted before subscribe are dropped (no retroactive replay)", async () => {
    const bus = new ExecutionEventBus();
    bus.emit(ev("execution_started"));
    const sub = bus.subscribe("e1");
    bus.emit(ev("execution_terminal"));
    expect((await collect(sub.stream)).map((e) => e.event)).toEqual(["execution_terminal"]);
  });

  test("two subscribers on one execution both fan out; unsubscribe isolates", async () => {
    const bus = new ExecutionEventBus();
    const a = bus.subscribe("e1");
    const b = bus.subscribe("e1");
    bus.emit(ev("node_started"));
    b.unsubscribe();
    bus.emit(ev("execution_terminal"));
    expect((await collect(a.stream)).map((e) => e.event)).toEqual([
      "node_started",
      "execution_terminal",
    ]);
  });

  test("other executions do not cross-deliver", async () => {
    const bus = new ExecutionEventBus();
    const a = bus.subscribe("e1");
    bus.emit(ev("node_started", "e2"));
    bus.emit(ev("execution_terminal", "e1"));
    expect((await collect(a.stream)).map((e) => e.executionId)).toEqual(["e1"]);
  });

  test("unsubscribe releases a parked consumer and swallows late emits (M6)", async () => {
    const bus = new ExecutionEventBus();
    const sub = bus.subscribe("e1");
    const iter = sub.stream[Symbol.asyncIterator]();
    const pending = iter.next(); // parks: no events yet
    sub.unsubscribe();
    bus.emit(ev("late_event_after_unsubscribe_planned"));
    const done = await Promise.race([
      pending,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("consumer never released")), 2000),
      ),
    ]);
    // The post-close emit must be DROPPED, not buffered or delivered: a
    // closed queue that stores events would resolve the consumer with them.
    expect(done.done).toBe(true);
  });

  test("emit after unsubscribe does not accumulate dead queues", () => {
    const bus = new ExecutionEventBus();
    const sub = bus.subscribe("e1");
    sub.unsubscribe();
    expect(() => bus.emit(ev("node_started"))).not.toThrow();
    // Re-subscribing gets a fresh queue, not the stale one.
    const fresh = bus.subscribe("e1");
    bus.emit(ev("execution_terminal"));
    return collect(fresh.stream).then((got) =>
      expect(got.map((e) => e.event)).toEqual(["execution_terminal"]),
    );
  });

  test("emit to an execution with no subscriber is a no-op", () => {
    const bus = new ExecutionEventBus();
    expect(() => bus.emit(ev("node_started", "ghost"))).not.toThrow();
    bus.dispose();
  });

  test("dispose clears all queues", () => {
    const bus = new ExecutionEventBus();
    bus.subscribe("e1");
    bus.subscribe("e2");
    expect(() => bus.dispose()).not.toThrow();
    expect(() => bus.emit(ev("node_started"))).not.toThrow();
  });
});
