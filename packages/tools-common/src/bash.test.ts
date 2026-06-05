import { describe, expect, test } from "bun:test";
import { bashTool } from "./bash.js";

describe("bashTool", () => {
  test("exit code 0 returns stdout and stderr", async () => {
    const result = await bashTool.execute({
      command: "echo hello && echo world >&2",
    });

    expect(result.content).toInclude("exit=0");
    expect(result.content).toInclude("hello");
    expect(result.content).toInclude("world");
    expect(result.isError).toBeUndefined();
  });

  test("non-zero exit code returns isError", async () => {
    const result = await bashTool.execute({
      command: "exit 1",
    });

    expect(result.content).toInclude("exit=1");
    expect(result.isError).toBe(true);
  });

  test("timeout kills process", async () => {
    const result = await bashTool.execute({
      command: "sleep 10",
      timeout: 100,
    });

    // Killed by signal → exit code is signal-based, should be non-zero
    // Bun.spawn killed processes get exit code null or signal
    expect(result.isError).toBe(true);
  });

  test("default timeout is 30s (not enforced in fast test)", async () => {
    const result = await bashTool.execute({
      command: "true",
    });

    expect(result.content).toInclude("exit=0");
  });

  test("captures stdout and stderr separately", async () => {
    const result = await bashTool.execute({
      command: "echo stdout-text && echo stderr-text >&2",
    });

    expect(result.content).toInclude("--- stdout ---");
    expect(result.content).toInclude("--- stderr ---");
    expect(result.content).toInclude("stdout-text");
    expect(result.content).toInclude("stderr-text");
  });
});
