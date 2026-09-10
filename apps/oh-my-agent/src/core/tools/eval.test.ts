import { afterEach, describe, expect, test } from "bun:test";
import { defaultRegistry } from "../coordination/registry.js";
import { createEvalTool } from "./eval.js";

const evalTool = createEvalTool({ workspaceRoot: process.cwd(), scope: "test" });

afterEach(() => defaultRegistry.clearAll());

describe("evalTool", () => {
  test("evaluates a snippet and returns the result", async () => {
    const result = await evalTool.execute({
      description: "sum",
      code: "export default async (ctx) => ({ sum: ctx.a + ctx.b })",
      input: { a: 1, b: 2 },
    });
    expect(result.content).toContain('"sum": 3');
    expect(result.isError).toBeFalsy();
  });

  test("timeout 0 lets a slow cell finish (no deadline)", async () => {
    const result = await evalTool.execute({
      description: "slow but allowed",
      code: "export default async () => { await Bun.sleep(300); return { ok: true }; }",
      timeout: 0,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('"ok": true');
  }, 15_000);

  test("async=true registers a coordination entry with the result", async () => {
    const started = await evalTool.execute({
      description: "bg",
      code: "export default async () => ({ done: true })",
      async: true,
    });
    expect(started.content).toMatch(/Backgrounded as job eval_\d+/);
    const jobId = /eval_\d+/.exec(started.content)?.[0] ?? "";

    const deadline = Date.now() + 10_000;
    while (defaultRegistry.getEntry(jobId)?.status === "running" && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    const e = defaultRegistry.getEntry(jobId)!;
    expect(e.status).toBe("completed");
    expect(e.output).toContain('"done": true');
  }, 15_000);
});
