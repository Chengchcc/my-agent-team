import { describe, expect, test } from "bun:test";
import { MessageBatcher, renderMergedMessages } from "./merge-batch.js";

/** Manual clock: the window is observed by advancing time, never by sleeping. */
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

function recorder(): { batches: string[][]; onFlush: (batch: readonly string[]) => void } {
  const batches: string[][] = [];
  return {
    batches,
    onFlush: (batch) => {
      batches.push([...batch]);
    },
  };
}

describe("merge batcher (#83)", () => {
  test("messages inside the window become one batch, in order", () => {
    const time = fakeClock();
    const { batches, onFlush } = recorder();
    const batcher = new MessageBatcher<string>({ windowMs: 600, onFlush, clock: time.clock });

    batcher.push("topic-a|user-1", "first");
    time.advance(300);
    batcher.push("topic-a|user-1", "second");
    time.advance(300);
    batcher.push("topic-a|user-1", "third");
    expect(batches).toEqual([]); // still inside the window
    time.advance(600);
    expect(batches).toEqual([["first", "second", "third"]]);
    expect(batcher.openBatches()).toBe(0);
  });

  test("a message after the window starts a new batch", () => {
    const time = fakeClock();
    const { batches, onFlush } = recorder();
    const batcher = new MessageBatcher<string>({ windowMs: 600, onFlush, clock: time.clock });

    batcher.push("k", "one");
    time.advance(600);
    batcher.push("k", "two");
    time.advance(600);
    expect(batches).toEqual([["one"], ["two"]]);
  });

  test("the window is per key: another sender or topic never joins", () => {
    const time = fakeClock();
    const { batches, onFlush } = recorder();
    const batcher = new MessageBatcher<string>({ windowMs: 600, onFlush, clock: time.clock });

    batcher.push("topic-a|user-1", "mine");
    batcher.push("topic-a|user-2", "theirs");
    batcher.push("topic-b|user-1", "other topic");
    time.advance(600);
    expect(batches).toEqual([["mine"], ["theirs"], ["other topic"]]);
  });

  test("flushAll drains open batches without waiting out the window", async () => {
    const time = fakeClock();
    const { batches, onFlush } = recorder();
    const batcher = new MessageBatcher<string>({ windowMs: 600, onFlush, clock: time.clock });

    batcher.push("k", "pending");
    await batcher.flushAll();
    expect(batches).toEqual([["pending"]]);
    expect(batcher.openBatches()).toBe(0);
  });

  test("the merged text says how many originals it carries", () => {
    expect(renderMergedMessages(["我想加个功能", "  关于 workflow 的  ", "先看看现状"])).toBe(
      "【本轮合并了连续 3 条消息】\n1) 我想加个功能\n2) 关于 workflow 的\n3) 先看看现状",
    );
  });
});
