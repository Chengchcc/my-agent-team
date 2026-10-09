/** The per-workspace mutex (ADR 0023 §5). The behaviors that matter: callers on one root
 *  serialize, different roots do not, and a long wait behind a holder is SAID — because a run
 *  parked on a human ask holds its workspace for as long as the human takes (#59), and a
 *  silently-queued run reads as "running with no child and no logs". */
import { describe, expect, test } from "bun:test";
import { createWorkspaceLockRegistry } from "./workspace-lock.js";

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("workspace lock", () => {
  test("serializes callers on one root and frees it after", async () => {
    const locks = createWorkspaceLockRegistry();
    const order: string[] = [];
    const hold = (() => {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      return { gate, release };
    })();
    const first = locks.withLock("/w", async () => {
      order.push("first-start");
      await hold.gate;
      order.push("first-end");
    });
    const second = locks.withLock("/w", async () => {
      order.push("second-start");
    });
    await settle();
    expect(order).toEqual(["first-start"]);
    expect(locks.isLocked("/w")).toBe(true);
    hold.release();
    await Promise.all([first, second]);
    // Never interleaved, and the key is free again.
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
    expect(locks.isLocked("/w")).toBe(false);
  });

  test("a long wait behind a holder is warned about, naming the caller", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      const locks = createWorkspaceLockRegistry({ waitWarnMs: 5 });
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const holder = locks.withLock("/w", () => gate, "runId=holder");
      const waiter = locks.withLock("/w", async () => "ran", "runId=waiter");
      await new Promise((r) => setTimeout(r, 25));
      release();
      await Promise.all([holder, waiter]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("runId=waiter");
      expect(warnings[0]).toContain("parked on a human ask");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("an immediate acquisition stays silent", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      const locks = createWorkspaceLockRegistry({ waitWarnMs: 5 });
      await locks.withLock("/w", async () => 1, "runId=solo");
      await new Promise((r) => setTimeout(r, 15));
      expect(warnings).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });
});
