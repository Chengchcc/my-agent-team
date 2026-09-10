import { afterEach, describe, expect, test } from "bun:test";
import { createInMemorySessionStore } from "../agent-runtime.js";
import {
  appendEntryPartial,
  clearAll,
  getEntry,
  listEntries,
  registerEntry,
  stopEntry,
  updateEntry,
  waitEntries,
} from "./registry.js";

function processEntry(id: string, scope: string) {
  const { promise, resolve } = Promise.withResolvers<void>();
  return {
    id,
    kind: "bash" as const,
    scope,
    label: `cmd-${id}`,
    startedAt: Date.now(),
    status: "running" as const,
    finishedAt: null,
    partialText: "",
    settle: promise,
    resolve,
  };
}

describe("coordination registry", () => {
  afterEach(() => clearAll());

  test("register/get/list round-trips within a scope", () => {
    const e = processEntry("bg_1", "s1");
    registerEntry({ ...e, settle: e.settle });
    expect(getEntry("bg_1")?.kind).toBe("bash");
    expect(listEntries("s1").map((r) => r.id)).toEqual(["bg_1"]);
    expect(listEntries("s2")).toEqual([]); // scope isolation
  });

  test("partial text accumulates capped", () => {
    registerEntry(processEntry("bg_1", "s1"));
    appendEntryPartial("bg_1", "hello ");
    appendEntryPartial("bg_1", "world");
    expect(getEntry("bg_1")?.partialText).toBe("hello world");
  });

  test("updateEntry patches status and output", () => {
    registerEntry(processEntry("bg_1", "s1"));
    updateEntry("bg_1", { status: "completed", finishedAt: Date.now(), exitCode: 0, output: "hi" });
    expect(getEntry("bg_1")?.status).toBe("completed");
    expect(getEntry("bg_1")?.exitCode).toBe(0);
  });

  test("stopEntry kills process entries via their kill callback", () => {
    let killed = 0;
    registerEntry({ ...processEntry("bg_1", "s1"), kill: () => killed++ });
    expect(stopEntry("bg_1").ok).toBe(true);
    expect(killed).toBe(1);
    expect(stopEntry("missing").ok).toBe(false);
  });

  test("stopEntry rejects subagent ids (executor owns that stop)", () => {
    registerEntry({
      id: "sub-1",
      kind: "subagent",
      scope: "s1",
      label: "worker",
      startedAt: Date.now(),
      status: "running",
      finishedAt: null,
      partialText: "",
      store: createInMemorySessionStore(),
    });
    const out = stopEntry("sub-1");
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("delegation executor");
  });

  test("waitEntries resolves when jobs settle and times out otherwise", async () => {
    const a = processEntry("bg_1", "s1");
    const b = processEntry("bg_2", "s1");
    registerEntry(a);
    registerEntry(b);
    a.resolve();
    updateEntry("bg_1", { status: "completed", finishedAt: Date.now() });
    const done = await waitEntries({ scope: "s1", timeoutMs: 2000 });
    expect(done.settled.map((r) => r.id)).toEqual(["bg_1"]);
    expect(done.timedOut).toBe(false);
    const stuck = await waitEntries({ ids: ["bg_2"], scope: "s1", timeoutMs: 50 });
    expect(stuck.timedOut).toBe(true);
  });
  test("registerEntry rejects process jobs past the running cap", () => {
    for (let i = 0; i < 32; i++) {
      const e = processEntry(`bg_${i}`, "s1");
      registerEntry({ ...e, settle: e.settle });
    }
    const extra = processEntry("bg_x", "s1");
    const out = registerEntry({ ...extra, settle: extra.settle });
    expect(out.ok).toBe(false);
    expect(String((out as { error: string }).error)).toContain("too many running jobs");
  });
});
