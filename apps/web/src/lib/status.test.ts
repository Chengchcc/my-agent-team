import { describe, expect, test } from "bun:test";
import { badgeVariantFor, executionStatus } from "./status";

describe("one status vocabulary", () => {
  test("success and completed are the same state", () => {
    expect(executionStatus("success").tone).toBe(executionStatus("completed").tone);
    expect(executionStatus("success").shape).toBe("✓");
  });

  test("failure and failed read the same", () => {
    expect(executionStatus("failure").tone).toBe("err");
    expect(executionStatus("failed").shape).toBe("×");
  });

  test("every look carries a shape, not just a colour", () => {
    for (const status of ["completed", "failed", "running", "waiting", "timeout", "weird"]) {
      expect(executionStatus(status).shape).not.toBe("");
    }
  });

  test("tone maps to a badge variant in one place", () => {
    expect(badgeVariantFor("err")).toBe("destructive");
    expect(badgeVariantFor("ok")).toBe("default");
    expect(badgeVariantFor("warn")).toBe("secondary");
  });
});
