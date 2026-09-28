import { describe, expect, test } from "bun:test";
import {
  approvalTimeoutMs,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  requestApproval,
  withApprovalDeadline,
} from "./approval.js";

describe("requestApproval stamps the deadline (one number for every surface)", () => {
  test("the handler sees deadlineAt = now + timeout, and 0 means no deadline", async () => {
    const seen: Array<{ deadlineAt?: number }> = [];
    const handler = async (req: { deadlineAt?: number }) => {
      seen.push(req);
      return { decision: "allow" as const };
    };
    const before = Date.now();
    await requestApproval(
      handler as never,
      { callId: "c", toolName: "bash", input: {}, source: "permission" },
      60_000,
    );
    const stamped = seen[0]!.deadlineAt!;
    expect(stamped).toBeGreaterThanOrEqual(before + 60_000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 60_000);
    // 0 = wait forever: no claim on any card.
    await requestApproval(
      handler as never,
      { callId: "c", toolName: "bash", input: {}, source: "permission" },
      0,
    );
    expect(seen[1]!.deadlineAt).toBeUndefined();
  });

  test("an unstamped request keeps whatever the caller set", async () => {
    const seen: Array<{ deadlineAt?: number }> = [];
    await requestApproval(
      (async (req: { deadlineAt?: number }) => {
        seen.push(req);
        return { decision: "allow" as const };
      }) as never,
      { callId: "c", toolName: "bash", input: {}, source: "tool", deadlineAt: 123 },
      0,
    );
    expect(seen[0]!.deadlineAt).toBe(123);
  });
});

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
