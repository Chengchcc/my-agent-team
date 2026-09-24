import { describe, expect, test } from "bun:test";
import {
  approvalTimeoutMs,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  withApprovalDeadline,
} from "./approval.js";

describe("withApprovalDeadline", () => {
  test("the decision wins when it arrives within the deadline", async () => {
    const slow = Bun.sleep(20).then(() => ({ decision: "allow" as const }));
    expect(await withApprovalDeadline(slow, 5_000)).toEqual({ decision: "allow" });
  });

  test("a silent human fails closed to deny", async () => {
    const never = new Promise<{ decision: "allow" | "deny" }>(() => {});
    expect(await withApprovalDeadline(never, 10)).toEqual({
      decision: "deny",
      reason: "approval deadline exceeded",
    });
  });
});

describe("approvalTimeoutMs", () => {
  test("env knob: unset → default, 0 → wait, valid → honored, garbage → default", () => {
    const key = "OMA_APPROVAL_TIMEOUT_MS";
    const prev = process.env[key];
    try {
      delete process.env[key];
      expect(approvalTimeoutMs()).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);
      process.env[key] = "0";
      expect(approvalTimeoutMs()).toBe(0);
      process.env[key] = "5000";
      expect(approvalTimeoutMs()).toBe(5000);
      process.env[key] = "nonsense";
      expect(approvalTimeoutMs()).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });
});
