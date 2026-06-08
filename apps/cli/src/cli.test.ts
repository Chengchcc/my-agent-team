import { describe, expect, test } from "bun:test";

/** Extract --workspace value from argv, or undefined if not present. */
function resolveWorkspaceArg(args: string[]): string | undefined {
  return args.find((a) => a.startsWith("--workspace="))?.split("=")[1];
}

/** Extract --rm value from argv, or undefined if not present. */
function resolveRmAgentId(args: string[]): string | undefined {
  return args.find((a) => a.startsWith("--rm="))?.split("=")[1];
}

/** Check if --hard flag is present in argv. */
function hasHardFlag(args: string[]): boolean {
  return args.includes("--hard");
}

describe("CLI argument parsing", () => {
  test("--workspace flag is detected", () => {
    expect(resolveWorkspaceArg(["--workspace=/tmp/ws"])).toBe("/tmp/ws");
  });

  test("no --workspace returns undefined", () => {
    expect(resolveWorkspaceArg(["--model=claude-opus-4-7"])).toBeUndefined();
    expect(resolveWorkspaceArg([])).toBeUndefined();
  });

  test("--workspace can coexist with --model", () => {
    const args = ["--workspace=/tmp/ws", "--model=claude-sonnet-4-6"];
    expect(resolveWorkspaceArg(args)).toBe("/tmp/ws");

    const modelArg = args.find((a) => a.startsWith("--model="))?.split("=")[1];
    expect(modelArg).toBe("claude-sonnet-4-6");
  });

  test("--workspace value is the first segment after =", async () => {
    expect(resolveWorkspaceArg(["--workspace=/tmp/ws/sub"])).toBe("/tmp/ws/sub");
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
});
