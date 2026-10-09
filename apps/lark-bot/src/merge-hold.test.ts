import { describe, expect, test } from "bun:test";
import { MergeHold, renderMergedMessages } from "./merge-hold.js";

/** Manual clock: the safety cap is observed by advancing time, never by
 *  sleeping. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; handler: () => void }>();
  return {
    clock: {
      setTimeout(handler: () => void, ms: number): unknown {
        const id = nextId++;
        timers.set(id, { at: now + ms, handler });
        return id;
      },
      clearTimeout(handle: unknown): void {
        timers.delete(handle as number);
      },
    },
    advance(ms: number): void {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.handler();
        }
      }
    },
  };
}

describe("merge while the previous input is queued (#83)", () => {
  test("nothing is held when the conversation is idle", () => {
    const time = fakeClock();
    const batcher = new MergeHold<string>({
      maxHoldMs: 30_000,
      onFlush: () => {},
      clock: time.clock,
    });
    // The caller's contract: not holding means the message goes straight out.
    expect(batcher.isHolding("conv-1")).toBe(false);
    // Adding to a key nobody held is a no-op, not a leak.
    batcher.add("conv-1", "stray");
    time.advance(60_000);
    expect(batcher.isHolding("conv-1")).toBe(false);
  });

  test("messages arriving while queued become ONE input on release", async () => {
    const time = fakeClock();
    const batches: string[][] = [];
    const batcher = new MergeHold<string>({
      maxHoldMs: 30_000,
      onFlush: (batch) => {
        batches.push([...batch]);
      },
      clock: time.clock,
    });

    batcher.hold("conv-1"); // the previous input is queued
    batcher.add("conv-1", "还有一点");
    time.advance(5_000);
    batcher.add("conv-1", "顺便");
    expect(batches).toEqual([]); // queued until the previous input is picked up

    await batcher.release("conv-1"); // it was promoted → deliver what accumulated
    expect(batches).toEqual([["还有一点", "顺便"]]);
    expect(batcher.isHolding("conv-1")).toBe(false);
  });

  test("a release with nothing accumulated flushes nothing", async () => {
    const time = fakeClock();
    const batches: string[][] = [];
    const batcher = new MergeHold<string>({
      maxHoldMs: 30_000,
      onFlush: (batch) => {
        batches.push([...batch]);
      },
      clock: time.clock,
    });
    batcher.hold("conv-1");
    await batcher.release("conv-1");
    expect(batches).toEqual([]);
  });

  test("a stuck hold cannot swallow messages: the cap delivers them", () => {
    const time = fakeClock();
    const batches: string[][] = [];
    const batcher = new MergeHold<string>({
      maxHoldMs: 30_000,
      onFlush: (batch) => {
        batches.push([...batch]);
      },
      clock: time.clock,
    });
    batcher.hold("conv-1"); // e.g. its queued input was cancelled elsewhere
    batcher.add("conv-1", "late thought");
    time.advance(30_000);
    expect(batches).toEqual([["late thought"]]);
    expect(batcher.isHolding("conv-1")).toBe(false);
  });

  test("keys are isolated: another conversation is unaffected", () => {
    const time = fakeClock();
    const batches: string[][] = [];
    const batcher = new MergeHold<string>({
      maxHoldMs: 30_000,
      onFlush: (batch) => {
        batches.push([...batch]);
      },
      clock: time.clock,
    });
    batcher.hold("conv-1");
    expect(batcher.isHolding("conv-2")).toBe(false);
    batcher.add("conv-2", "must not be captured");
    time.advance(60_000);
    expect(batches).toEqual([]);
  });

  test("flushAll drains a hold (shutdown)", async () => {
    const time = fakeClock();
    const batches: string[][] = [];
    const batcher = new MergeHold<string>({
      maxHoldMs: 30_000,
      onFlush: (batch) => {
        batches.push([...batch]);
      },
      clock: time.clock,
    });
    batcher.hold("conv-1");
    batcher.add("conv-1", "pending");
    await batcher.flushAll();
    expect(batches).toEqual([["pending"]]);
  });

  test("the merged text says how many originals it carries", () => {
    expect(renderMergedMessages(["我想加个功能", "  关于 workflow 的  ", "先看看现状"])).toBe(
      "【本轮合并了连续 3 条消息】\n1) 我想加个功能\n2) 关于 workflow 的\n3) 先看看现状",
    );
  });
});
