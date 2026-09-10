import { describe, expect, test } from "bun:test";
import { evaluateOrchestrationScript } from "./script-runner.js";

const primitives = {
  agent: async (prompt: string) => ({
    text: `echo:${prompt}`,
    output: undefined,
    ok: true,
    label: "",
  }),
  pipeline: async (items: readonly unknown[], fn: (item: unknown) => Promise<unknown>) =>
    Promise.all(items.map(fn)),
};

describe("evaluateOrchestrationScript", () => {
  test("runs top-level await scripts with agent + pipeline", async () => {
    const result = await evaluateOrchestrationScript({
      script:
        'const found = await agent("find"); const all = await pipeline([1, 2], (x) => agent(String(x))); return all.length;',
      args: undefined,
      primitives: primitives as never,
    });
    expect(result.value).toBe(2);
  });

  test("args are passed as a global", async () => {
    const result = await evaluateOrchestrationScript({
      script: "return args.count * 2;",
      args: { count: 21 },
      primitives: primitives as never,
    });
    expect(result.value).toBe(42);
  });

  test("fs/process/require are absent inside the sandbox", async () => {
    // typeof never throws for undeclared names: the value proves absence.
    const processType = await evaluateOrchestrationScript({
      script: "return typeof process;",
      args: undefined,
      primitives: primitives as never,
    });
    expect(processType.value).toBe("undefined");
    const requireType = await evaluateOrchestrationScript({
      script: "return typeof require;",
      args: undefined,
      primitives: primitives as never,
    });
    expect(requireType.value).toBe("undefined");
    // Direct access throws.
    await expect(
      evaluateOrchestrationScript({
        script: "return process;",
        args: undefined,
        primitives: primitives as never,
      }),
    ).rejects.toThrow(/process is not defined/);
  });

  test("the timeout aborts a synchronous infinite loop", async () => {
    await expect(
      evaluateOrchestrationScript({
        script: "while (true) {}",
        args: undefined,
        primitives: primitives as never,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out|Script execution timed out/);
  });

  test("the timeout races an async stall", async () => {
    await expect(
      evaluateOrchestrationScript({
        script: "await new Promise(() => {});",
        args: undefined,
        primitives: primitives as never,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out/);
  });
});
