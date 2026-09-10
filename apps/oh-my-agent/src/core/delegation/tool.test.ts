import { describe, expect, test } from "bun:test";
import type { SubagentSpec } from "./executor.js";
import { createDelegationTools, isValidWorkflowName, parseAgentDefinition } from "./tool.js";

const agentDefs = new Map<string, string>();
const subagentCalls: Array<{ spec: SubagentSpec; signal?: AbortSignal }> = [];
const batchCalls: Array<{
  input: {
    batchId: string;
    label: string;
    items: readonly SubagentSpec[];
    signal?: AbortSignal;
  };
}> = [];
const deps = {
  runBatch: async (input: {
    batchId: string;
    label: string;
    items: readonly SubagentSpec[];
    signal?: AbortSignal;
  }) => {
    batchCalls.push({ input });
    return {
      items: input.items.map((spec, i) => ({
        label: spec.label ?? `a${i}`,
        text: "ok",
        ok: true,
      })),
      totalTokens: 0,
      ok: true,
    };
  },
  runSubagent: async (spec: SubagentSpec, signal?: AbortSignal) => {
    subagentCalls.push({ spec, signal });
    return { label: spec.label ?? "sub", text: "ok", ok: true };
  },
  readAgentDefinition: async (name: string) => agentDefs.get(name) ?? null,
  listSubagents: () => [],
  getSubagentOutput: (handle: string) => ({ handle, status: "unknown" }),
  stopSubagent: (handle: string) => ({ ok: false, error: `unknown subagent handle "${handle}"` }),
};
const tools = createDelegationTools(deps);
const subagentTool = tools.find((t) => t.name === "task")!;
const subagentListTool = tools.find((t) => t.name === "task_list")!;
const subagentOutputTool = tools.find((t) => t.name === "task_output")!;
const subagentStopTool = tools.find((t) => t.name === "task_stop")!;

describe("task batch fan-out (pi shape)", () => {
  test("fans out via runBatch with shared context prepended to every spawn", async () => {
    batchCalls.length = 0;
    const result = (await subagentTool.execute({
      context: "SHARED-BG",
      tasks: [
        { name: "one", agent: "explore", task: "investigate A" },
        { name: "two", agent: "task", task: "investigate B", outputSchema: { type: "object" } },
      ],
    })) as { content: string; results: Array<{ name: string; ok: boolean }> };
    expect(result.ok).toBe(true);
    expect(result.results.map((r) => r.name)).toEqual(["one", "two"]);
    expect(batchCalls).toHaveLength(1);
    const items = batchCalls[0]!.input.items;
    expect(items).toHaveLength(2);
    expect(items[0]!.prompt).toContain("SHARED-BG");
    expect(items[0]!.prompt).toContain("investigate A");
    expect(items[0]!.label).toBe("one");
    expect(items[1]!.schema).toEqual({ type: "object" });
    expect(items[1]!.systemPrompt).toContain("general-purpose task subagent");
  });

  test("validates batch shape before spawning", async () => {
    batchCalls.length = 0;
    const missingContext = (await subagentTool.execute({
      tasks: [{ task: "x" }],
    })) as { error: string };
    expect(missingContext.error).toContain("context is required");
    const emptyTasks = (await subagentTool.execute({ context: "c", tasks: [] })) as {
      error: string;
    };
    expect(emptyTasks.error).toContain("non-empty");
    const dup = (await subagentTool.execute({
      context: "c",
      tasks: [
        { task: "a", name: "same" },
        { task: "b", name: "same" },
      ],
    })) as { error: string };
    expect(dup.error).toContain("duplicate task name");
    expect(batchCalls.length).toBe(0);
  });

  test("unknown role fails the whole call before any spawn", async () => {
    batchCalls.length = 0;
    const result = (await subagentTool.execute({
      context: "c",
      tasks: [{ agent: "mystery", task: "x" }],
    })) as { error: string };
    expect(result.error).toContain('unknown subagent "mystery"');
    expect(batchCalls.length).toBe(0);
  });
});

describe("subagent", () => {
  test("dispatches builtin explore with read-only tools (3.4)", async () => {
    subagentCalls.length = 0;
    const out = (await subagentTool.execute({ agent: "explore", prompt: "look around" })) as {
      ok?: boolean;
    };
    expect(out.ok).toBe(true);
    const call = subagentCalls[0]!;
    expect(call.spec.systemPrompt).toContain("read-only");
    expect(call.spec.toolNames).toEqual(["read", "grep", "glob", "tree", "read_image"]);
  });

  test("loads .oma/agents/<name>.md definitions (3.4)", async () => {
    subagentCalls.length = 0;
    agentDefs.set(
      "reviewer",
      "---\nname: reviewer\ntools: [read, grep]\nmodel: fake/big\n---\nYou review code carefully.",
    );
    const out = (await subagentTool.execute({ agent: "reviewer", prompt: "review" })) as {
      ok?: boolean;
    };
    expect(out.ok).toBe(true);
    const call = subagentCalls[0]!;
    expect(call.spec.systemPrompt).toBe("You review code carefully.");
    expect(call.spec.toolNames).toEqual(["read", "grep"]);
    expect(call.spec.modelId).toBe("fake/big");
    expect(call.spec.label).toBe("reviewer");
  });

  test("rejects unknown agents with a clear error and the builtin list", async () => {
    const out = (await subagentTool.execute({ agent: "nope", prompt: "x" })) as {
      ok?: boolean;
      error?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("unknown subagent");
    expect(out.error).toContain("explore, plan, task");
  });

  test("requires prompt (and agent or resume)", async () => {
    const noPrompt = (await subagentTool.execute({ agent: "explore" })) as {
      ok?: boolean;
      error?: string;
    };
    expect(noPrompt.ok).toBe(false);
    expect(noPrompt.error).toContain("prompt is required");
    const noAgent = (await subagentTool.execute({ prompt: "x" })) as {
      ok?: boolean;
      error?: string;
    };
    expect(noAgent.ok).toBe(false);
    expect(noAgent.error).toContain("agent (or resume handle)");
  });

  test("surfaces the handle and resumes with it (3.4 Phase 2)", async () => {
    subagentCalls.length = 0;
    const handle = "sub-abc123";
    const originalRunSubagent = deps.runSubagent;
    deps.runSubagent = async (spec, signal) => {
      subagentCalls.push({ spec, signal });
      return {
        label: spec.label ?? "sub",
        text: spec.resumeHandle ? "follow-up done" : "first done",
        ok: true,
        handle,
      };
    };
    try {
      const first = (await subagentTool.execute({ agent: "explore", prompt: "first" })) as {
        handle?: string;
      };
      expect(first.handle).toBe(handle);
      const resumed = (await subagentTool.execute({ resume: handle, prompt: "more" })) as {
        ok?: boolean;
        text?: string;
      };
      expect(resumed.ok).toBe(true);
      expect(resumed.text).toBe("follow-up done");
      expect(subagentCalls[1]?.spec.resumeHandle).toBe(handle);
    } finally {
      deps.runSubagent = originalRunSubagent;
    }
  });
});

describe("parseAgentDefinition", () => {
  test("parses the four frontmatter fields and body", () => {
    const def = parseAgentDefinition(
      "---\nname: reviewer\ndescription: Reviews diffs\ntools: [read, grep]\nmodel: fake/big\n---\nBody prompt",
    );
    expect(def?.systemPrompt).toBe("Body prompt");
    expect(def?.tools).toEqual(["read", "grep"]);
    expect(def?.modelId).toBe("fake/big");
    expect(def?.description).toBe("Reviews diffs");
  });

  test("returns null without a name or frontmatter", () => {
    expect(parseAgentDefinition("Just a prompt.")).toBeNull();
    expect(parseAgentDefinition("---\ntools: [read]\n---\nNo name")).toBeNull();
  });
});

describe("subagent control plane", () => {
  test("subagent_output and subagent_stop delegate to the deps", async () => {
    const out = (await subagentOutputTool.execute({ handle: "sub-x" })) as {
      status?: string;
    };
    expect(out.status).toBe("unknown");
    const stopped = (await subagentStopTool.execute({ handle: "sub-x" })) as {
      ok?: boolean;
      error?: string;
    };
    expect(stopped.ok).toBe(false);
    expect(stopped.error).toContain("unknown subagent handle");
  });

  test("subagent_list returns the dep list", async () => {
    const out = (await subagentListTool.execute({})) as { tasks?: unknown[] };
    expect(out.tasks).toEqual([]);
  });

  test("requires a handle for output/stop", async () => {
    const out = (await subagentOutputTool.execute({})) as { ok?: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("handle is required");
  });
});

describe("delegation tool names", () => {
  test("isValidWorkflowName rejects path segments", () => {
    expect(isValidWorkflowName("audit")).toBe(true);
    expect(isValidWorkflowName("../audit")).toBe(false);
    expect(isValidWorkflowName("a/b")).toBe(false);
    expect(isValidWorkflowName("")).toBe(false);
  });

  test("four delegation tools are registered", () => {
    expect(subagentTool.name).toBe("task");
    expect(subagentListTool.name).toBe("task_list");
    expect(subagentOutputTool.name).toBe("task_output");
    expect(subagentStopTool.name).toBe("task_stop");
    expect(tools).toHaveLength(4);
  });
});
