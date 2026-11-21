import { describe, expect, test } from "bun:test";
import { cardTerminalOf } from "./run-card-watcher.js";

/** Live 2026-11-21: a card sat on "思考中" for minutes while its run had
 *  completed — the terminal frame never reached the seal. The watchdog reads
 *  the backend's own word instead, so the mapping must be exactly right:
 *  aborted is a STOP the human asked for, not a failure. */
describe("card terminal mapping", () => {
  test("completed stays completed", () => {
    expect(cardTerminalOf("completed")).toEqual({ status: "completed" });
  });

  test("aborted reads as cancelled, never as failed", () => {
    expect(cardTerminalOf("aborted")).toEqual({ status: "cancelled" });
  });

  test("failed and timeout read as failed", () => {
    expect(cardTerminalOf("failed")).toEqual({ status: "failed" });
    expect(cardTerminalOf("timeout")).toEqual({ status: "failed" });
  });

  test("anything still running has no terminal frame", () => {
    for (const status of ["running", "waiting", "queued"]) {
      expect(cardTerminalOf(status)).toBeNull();
    }
  });
});
