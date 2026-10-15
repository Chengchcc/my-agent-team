import { describe, expect, test } from "bun:test";
import { CARD_WRITE_MIN_SPACING_MS, paceCardWrite, resetCardPacerLanes } from "./card-pacer.js";

/** A clock that never actually waits: it records every spacing request and
 *  resolves immediately, so the assertions are about order and requested
 *  spacing, never about timers firing. */
function recordingClock(startAt: number) {
  const now = startAt;
  const waits: number[] = [];
  return {
    clock: {
      now: () => now,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    },
    waits,
  };
}

describe("the per-chat card write lane (#87)", () => {
  test("writes to one chat serialize; the second asks for the spacing", async () => {
    resetCardPacerLanes();
    const { clock, waits } = recordingClock(10_000);
    const order: string[] = [];
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const a = paceCardWrite(
      "chat-1",
      async () => {
        order.push("a");
        await gateA;
      },
      clock,
    );
    const b = paceCardWrite(
      "chat-1",
      async () => {
        order.push("b");
      },
      clock,
    );

    // a started immediately (a fresh lane waits for nothing) and b has not.
    // The lane runs its turn on a microtask chain, so let it start.
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["a"]);
    releaseA();
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
    // b ran at the same fake instant a did, so the full spacing was requested.
    expect(waits).toEqual([CARD_WRITE_MIN_SPACING_MS]);
  });

  test("another chat's lane is independent", async () => {
    resetCardPacerLanes();
    const { clock, waits } = recordingClock(10_000);
    const order: string[] = [];
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const a = paceCardWrite(
      "chat-1",
      async () => {
        order.push("a");
        await gateA;
      },
      clock,
    );
    const b = paceCardWrite(
      "chat-2",
      async () => {
        order.push("b");
      },
      clock,
    );
    await b;
    await new Promise((r) => setTimeout(r, 0));
    // a started (it never waits on a fresh lane) but is still gated; b ran to
    // completion anyway — chat-2 was not serialized behind chat-1.
    expect(order).toEqual(["a", "b"]);
    releaseA();
    await a;
    expect(order).toEqual(["a", "b"]);
    expect(waits).toEqual([]);
  });

  test("a failing write does not poison the lane", async () => {
    resetCardPacerLanes();
    const { clock } = recordingClock(10_000);
    const a = paceCardWrite(
      "chat-1",
      async () => {
        throw new Error("boom");
      },
      clock,
    );
    await a.catch(() => {});
    const b = await paceCardWrite("chat-1", async () => "still runs", clock);
    expect(b).toBe("still runs");
  });
});
