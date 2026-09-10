import { describe, expect, test } from "bun:test";
import { createOrchestrateTool } from "./tool.js";

const saved = new Map<string, string>();
const deps = {
  runScript: async (input: { script: string }) => ({
    ok: true,
    totalTokens: 0,
    value: `ran:${input.script.slice(0, 8)}`,
  }),
  writeScript: (name: string, content: string) => {
    saved.set(name, content);
  },
  readScript: async (name: string) => saved.get(name) ?? null,
};
const tools = createOrchestrateTool(deps);
const runScriptTool = tools.find((t) => t.name === "workflow_run")!;

describe("workflow_run", () => {
  test("saves a script and re-runs it by name only (B8)", async () => {
    const first = (await runScriptTool.execute({ script: "const a = 1;", name: "audit" })) as {
      scriptSaved?: boolean;
      ok?: boolean;
    };
    expect(first.scriptSaved).toBe(true);
    expect(saved.get("audit")).toBe("const a = 1;");

    const second = (await runScriptTool.execute({ name: "audit" })) as {
      scriptSaved?: boolean;
      ok?: boolean;
      value?: unknown;
    };
    expect(second.scriptSaved).toBe(false);
    expect(second.ok).toBe(true);
    expect(String(second.value)).toContain("ran:const a");
  });

  test("rejects an unknown saved name", async () => {
    const out = (await runScriptTool.execute({ name: "missing" })) as {
      ok?: boolean;
      error?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("not found");
  });

  test("rejects path-escape names", async () => {
    const out = (await runScriptTool.execute({ name: "../evil" })) as {
      ok?: boolean;
      error?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("invalid workflow name");
  });

  test("requires script or name", async () => {
    const out = (await runScriptTool.execute({})) as { ok?: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("script or name");
  });
});
