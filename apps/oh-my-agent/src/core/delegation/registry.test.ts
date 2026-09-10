import { afterEach, describe, expect, test } from "bun:test";
import { createInMemorySessionStore } from "../agent-runtime.js";
import type { SubagentSpec } from "./executor.js";
import {
  appendSubagentPartial,
  clearSubagents,
  getSubagent,
  listSubagents,
  registerSubagent,
  updateSubagentStatus,
} from "./registry.js";

const spec: SubagentSpec = { prompt: "do it", label: "worker" };

function entry(handle: string, createdAt: number) {
  return {
    handle,
    sessionId: `wf:b:${handle}`,
    batchId: "b",
    agentId: handle,
    label: "worker",
    spec,
    store: createInMemorySessionStore(),
    status: "running" as const,
    partialText: "",
    createdAt,
  };
}

describe("subagent registry", () => {
  afterEach(() => {
    clearSubagents();
  });

  test("register/get/list round-trips a handle", () => {
    registerSubagent(entry("sub-1", 1));
    const got = getSubagent("sub-1");
    expect(got?.handle).toBe("sub-1");
    expect(listSubagents().map((s) => s.handle)).toEqual(["sub-1"]);
    expect(getSubagent("missing")).toBeUndefined();
  });

  test("partial text accumulates with a cap", () => {
    registerSubagent(entry("sub-1", 1));
    appendSubagentPartial("sub-1", "hello ");
    appendSubagentPartial("sub-1", "world");
    expect(getSubagent("sub-1")?.partialText).toBe("hello world");
  });

  test("status updates land on the entry", () => {
    registerSubagent(entry("sub-1", 1));
    updateSubagentStatus("sub-1", "completed", {
      label: "worker",
      text: "done",
      ok: true,
      status: "completed",
    });
    expect(getSubagent("sub-1")?.status).toBe("completed");
    expect(getSubagent("sub-1")?.result?.text).toBe("done");
  });

  test("cap evicts the oldest non-running handle, never a running one", () => {
    registerSubagent(entry("sub-1", 1));
    updateSubagentStatus("sub-1", "completed");
    // Fill past the cap with running entries: running handles are never
    // evicted, so only the completed one is reclaimed and the cap is soft.
    for (let i = 2; i <= 20; i++) {
      registerSubagent(entry(`sub-${i}`, i));
    }
    const handles = listSubagents().map((s) => s.handle);
    expect(handles).not.toContain("sub-1"); // oldest non-running evicted
    expect(handles).toHaveLength(19); // running handles survive the cap
  });
});
