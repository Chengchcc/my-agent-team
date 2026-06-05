import { describe, expect, test } from "bun:test";

/** Extract --workspace value from argv, or undefined if not present. */
function resolveWorkspaceArg(args: string[]): string | undefined {
  return args.find((a) => a.startsWith("--workspace="))?.split("=")[1];
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
    // split('=')[1] takes the text between first and second =
    expect(resolveWorkspaceArg(["--workspace=/tmp/ws/sub"])).toBe("/tmp/ws/sub");
  });
});
