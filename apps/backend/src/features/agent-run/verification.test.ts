import { describe, expect, test } from "bun:test";
import type { BackendRunOutcome } from "@chengchenccc/agent-contract";
import { deriveVerification } from "./http.js";

function outcome(partial: Partial<BackendRunOutcome>): BackendRunOutcome {
  return { status: "completed", messages: [], ...partial } as BackendRunOutcome;
}

describe("run verification scorecard", () => {
  test("null outcome -> unknown, no claims", () => {
    const v = deriveVerification(null);
    expect(v.verdict).toBe("unknown");
    expect(v.assistantClaimedDone).toBe(false);
    expect(v.verificationCommands).toHaveLength(0);
  });

  test("counts tool errors, detects eval + verification commands, flags assistant text", () => {
    const v = deriveVerification(
      outcome({
        messages: [
          {
            role: "assistant",
            blocks: [
              {
                type: "tool_use",
                id: "t1",
                name: "bash",
                input: { command: "bun test foo.test.ts" },
              },
              { type: "tool_use", id: "t2", name: "bash", input: { command: "echo hello" } },
              { type: "tool_use", id: "t3", name: "eval", input: { code: "1+1" } },
            ],
          },
          {
            role: "tool",
            blocks: [
              { type: "tool_result", tool_use_id: "t1", content: "ok" },
              { type: "tool_result", tool_use_id: "t2", content: "boom", is_error: true },
            ],
          },
          { role: "assistant", blocks: [{ type: "text", text: "done" }] },
        ],
      }),
    );
    expect(v.toolErrorCount).toBe(1);
    expect(v.usedEval).toBe(true);
    expect(v.verificationCommands).toEqual(["bun test foo.test.ts"]);
    expect(v.assistantClaimedDone).toBe(true);
    // A tool error downgrades the verdict even though the run completed.
    expect(v.verdict).toBe("fail");
  });

  test("non-completed outcome carries the failure cause, verdict unknown", () => {
    const v = deriveVerification(outcome({ status: "failed", error: "model 500" }));
    expect(v.verdict).toBe("unknown");
    expect(v.failureCause).toBe("model 500");
  });
});
