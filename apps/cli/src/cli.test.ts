import { describe, expect, test } from "bun:test";
import { hasFlag, parseFlag, resolveRmAgentId, hasHardFlag } from "./args.js";

describe("CLI argument parsing", () => {
  test("--workspace flag is detected", () => {
    expect(parseFlag(["--workspace=/tmp/ws"], "workspace")).toBe("/tmp/ws");
  });

  test("no --workspace returns undefined", () => {
    expect(parseFlag(["--model=claude-opus-4-7"], "workspace")).toBeUndefined();
    expect(parseFlag([], "workspace")).toBeUndefined();
  });

  test("--workspace can coexist with --model", () => {
    const args = ["--workspace=/tmp/ws", "--model=claude-sonnet-4-6"];
    expect(parseFlag(args, "workspace")).toBe("/tmp/ws");
    expect(parseFlag(args, "model")).toBe("claude-sonnet-4-6");
  });

  test("--workspace value is the first segment after =", () => {
    expect(parseFlag(["--workspace=/tmp/ws/sub"], "workspace")).toBe("/tmp/ws/sub");
  });

  // ─── M11: --rm flag ──────────────────────────────────────────

  test("--rm flag is detected", () => {
    expect(resolveRmAgentId(["--rm=abc123"])).toBe("abc123");
  });

  test("--rm with --hard flag", () => {
    const args = ["--rm=abc123", "--hard", "--backend=http://localhost:3000"];
    expect(resolveRmAgentId(args)).toBe("abc123");
    expect(hasHardFlag(args)).toBe(true);
  });

  test("--rm without --hard (soft delete / archive)", () => {
    const args = ["--rm=abc123", "--backend=http://localhost:3000"];
    expect(resolveRmAgentId(args)).toBe("abc123");
    expect(hasHardFlag(args)).toBe(false);
  });

  test("no --rm returns undefined", () => {
    expect(resolveRmAgentId(["--workspace=/tmp/ws"])).toBeUndefined();
    expect(resolveRmAgentId([])).toBeUndefined();
  });

  // ─── hasFlag utility ──────────────────────────────────────

  test("hasFlag detects present flag", () => {
    expect(hasFlag(["--verbose", "--hard"], "hard")).toBe(true);
    expect(hasFlag(["--hard"], "hard")).toBe(true);
  });

  test("hasFlag returns false for absent flag", () => {
    expect(hasFlag(["--verbose"], "hard")).toBe(false);
    expect(hasFlag([], "hard")).toBe(false);
  });
});
