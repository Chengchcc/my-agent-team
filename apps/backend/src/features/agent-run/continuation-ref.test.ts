import { describe, expect, test } from "bun:test";
import { resolveContinuationRef } from "./continuation-ref.js";

describe("#25: which native session a dispatch continues in", () => {
  test("the run's own ref wins over the branch pointer", () => {
    // A re-dispatched run (HITL resume, crash recovery) continues in the
    // session IT bound — the branch pointer still names the previous turn.
    expect(
      resolveContinuationRef({
        runNativeRef: "sess-run",
        branchRef: "oma:sess-branch",
        kindPrefix: "oma:",
      }),
    ).toBe("sess-run");
  });

  test("a fresh run (no ref of its own) falls back to the branch pointer", () => {
    expect(
      resolveContinuationRef({
        runNativeRef: null,
        branchRef: "oma:sess-branch",
        kindPrefix: "oma:",
      }),
    ).toBe("sess-branch");
  });

  test("a foreign backend's branch pointer is never forwarded", () => {
    // pi exits empty on a foreign --session id: the scope check is the guard.
    expect(
      resolveContinuationRef({
        runNativeRef: null,
        branchRef: "omp:sess-other",
        kindPrefix: "oma:",
      }),
    ).toBeUndefined();
    expect(
      resolveContinuationRef({ runNativeRef: null, branchRef: null, kindPrefix: "oma:" }),
    ).toBeUndefined();
  });
});
