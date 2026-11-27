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
        timeoutMs: 150,
      }),
    ).rejects.toThrow(/timed out|Script execution timed out/);
  });

  test("the timeout races an async stall", async () => {
    await expect(
      evaluateOrchestrationScript({
        script: "await new Promise(() => {});",
        args: undefined,
        primitives: primitives as never,
        timeoutMs: 150,
      }),
    ).rejects.toThrow(/timed out/);
  });

  test("microtask infinite loop is killed cleanly by timeout without freezing host (P0-1)", async () => {
    await expect(
      evaluateOrchestrationScript({
        script: "await Promise.resolve(); while (true) {}",
        args: undefined,
        primitives: primitives as never,
        timeoutMs: 150,
      }),
    ).rejects.toThrow(/timed out/);
  });

  test("isolated subprocess does not expose host process.env secrets (P0-1)", async () => {
    const saved = process.env.OMA_HOST_SECRET_CANARY;
    process.env.OMA_HOST_SECRET_CANARY = "super-secret-value";
    try {
      const result = await evaluateOrchestrationScript({
        script: `
          let leaked = null;
          try {
            const p = agent.constructor.constructor("return process")();
            leaked = p?.env?.OMA_HOST_SECRET_CANARY ?? null;
          } catch {
            leaked = "blocked";
          }
          return leaked;
        `,
        args: undefined,
        primitives: primitives as never,
        timeoutMs: 2_000,
      });
      expect(result.value).not.toBe("super-secret-value");
    } finally {
      if (saved === undefined) delete process.env.OMA_HOST_SECRET_CANARY;
      else process.env.OMA_HOST_SECRET_CANARY = saved;
    }
  });
});
