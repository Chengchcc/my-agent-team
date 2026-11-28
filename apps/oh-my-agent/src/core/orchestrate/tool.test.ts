import { describe, expect, test } from "bun:test";
import { createOrchestrateTool } from "./tool.js";

const saved = new Map<string, string>();
let lastCall: {
  script: string;
  args?: unknown;
  label?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
} | null = null;
const deps = {
  runScript: async (input: {
    script: string;
    args?: unknown;
    label?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }) => {
    lastCall = input;
    return {
      ok: true,
      totalTokens: 15,
      usage: { inputTokens: 10, outputTokens: 5 },
      value: `ran:${input.script.slice(0, 8)}`,
      logs: ["step 1"],
    };
  },
  writeScript: (name: string, content: string) => {
    saved.set(name, content);
  },
  readScript: async (name: string) => saved.get(name) ?? null,
};
const tools = createOrchestrateTool(deps);
const orchestrateTool = tools.find((t) => t.name === "orchestrate")!;

describe("orchestrate tool", () => {
  test("saves a script and re-runs it by name only, forwarding signal/timeout/logs", async () => {
    const ac = new AbortController();
    const first = (await orchestrateTool.execute(
      { script: "const a = 1;", name: "audit", timeoutMs: 120_000 },
      ac.signal,
    )) as {
      scriptSaved?: boolean;
      ok?: boolean;
      logs?: string[];
      usage?: { inputTokens: number; outputTokens: number };
    };
    expect(first.scriptSaved).toBe(true);
    expect(first.logs).toEqual(["step 1"]);
    expect(first.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(lastCall?.signal).toBe(ac.signal);
    expect(lastCall?.timeoutMs).toBe(120_000);
    expect(lastCall?.label).toBe("audit");
    expect(saved.get("audit")).toBe("const a = 1;");

    const second = (await orchestrateTool.execute({ name: "audit" })) as {
      scriptSaved?: boolean;
      ok?: boolean;
      value?: unknown;
    };
    expect(second.scriptSaved).toBe(false);
    expect(second.ok).toBe(true);
    expect(String(second.value)).toContain("ran:const a");
  });

  test("rejects an unknown saved name", async () => {
    const out = (await orchestrateTool.execute({ name: "missing" })) as {
      ok?: boolean;
      error?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("not found");
  });

  test("rejects path-escape names", async () => {
    const out = (await orchestrateTool.execute({ name: "../evil" })) as {
      ok?: boolean;
      error?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("invalid orchestration name");
  });

  test("requires script or name", async () => {
    const out = (await orchestrateTool.execute({})) as { ok?: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("script or name");
  });
});
