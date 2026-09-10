import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { typedSource } from "./typed-source";

/** Minimal EventSource double: records listeners, replays payloads. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  url: string;
  readyState = 1;
  closed = false;
  listeners = new Map<string, (e: { data: string }) => void>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  addEventListener(name: string, cb: (e: { data: string }) => void) {
    this.listeners.set(name, cb);
  }
  close() {
    this.closed = true;
  }
  emit(name: string, data: unknown) {
    this.listeners.get(name)?.({ data: JSON.stringify(data) });
  }
  emitRaw(name: string, data: string) {
    this.listeners.get(name)?.({ data });
  }
}

const previous = globalThis.EventSource;
globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;

const map = { tick: z.object({ n: z.number() }) };

describe("typedSource", () => {
  test("connects to the given URL and delivers schema-valid payloads", () => {
    const received: Array<{ n: number }> = [];
    const src = typedSource("/api/sse", map, { onError: () => expect.unreachable() });
    expect(FakeEventSource.last!.url).toBe("/api/sse");

    src.on("tick", (data) => received.push(data));
    FakeEventSource.last!.emit("tick", { n: 7 });
    expect(received).toEqual([{ n: 7 }]);
    src.close();
  });

  test("schema violations route to onError, the callback never runs", () => {
    const errors: Array<string> = [];
    const received: unknown[] = [];
    const src = typedSource("/api/sse", map, { onError: (name) => errors.push(name) });
    src.on("tick", (data) => received.push(data));
    FakeEventSource.last!.emit("tick", { n: "not a number" });
    expect(received).toEqual([]);
    expect(errors).toEqual(["tick"]);
    src.close();
  });

  test("malformed JSON routes to onError without throwing", () => {
    const errors: Array<string> = [];
    const src = typedSource("/api/sse", map, { onError: (name) => errors.push(name) });
    src.on("tick", () => expect.unreachable());
    FakeEventSource.last!.emitRaw("tick", "{not json");
    expect(errors).toEqual(["tick"]);
    src.close();
  });

  test("event names are dispatched independently", () => {
    const ticks: number[] = [];
    const toasts: string[] = [];
    const src = typedSource("/api/sse", {
      tick: map.tick,
      toast: z.object({ text: z.string() }),
    });
    src.on("tick", (d) => ticks.push(d.n));
    src.on("toast", (d) => toasts.push(d.text));
    FakeEventSource.last!.emit("toast", { text: "hi" });
    FakeEventSource.last!.emit("tick", { n: 1 });
    expect(ticks).toEqual([1]);
    expect(toasts).toEqual(["hi"]);
    src.close();
  });

  test("close() closes the underlying EventSource", () => {
    const src = typedSource("/api/sse", map);
    const fake = FakeEventSource.last!;
    expect(src.readyState).toBe(fake.readyState);
    src.close();
    expect(fake.closed).toBe(true);
  });
});
