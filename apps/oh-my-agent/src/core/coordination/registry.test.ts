import { afterEach, describe, expect, test } from "bun:test";
import { createInMemorySessionStore } from "../index.js";
import { type CoordinationRegistry, createCoordinationRegistry } from "./registry.js";

/** Each test gets its OWN registry: the table is an injected instance, so
 *  tests no longer share (or clear) process-global state. */
let reg: CoordinationRegistry;
function freshRegistry(): CoordinationRegistry {
  reg = createCoordinationRegistry();
  return reg;
}
freshRegistry();

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
  afterEach(() => freshRegistry());

  test("register/get/list round-trips within a scope", () => {
    const e = processEntry("bg_1", "s1");
    reg.registerEntry({ ...e, settle: e.settle });
    expect(reg.getEntry("bg_1")?.kind).toBe("bash");
    expect(reg.listEntries("s1").map((r) => r.id)).toEqual(["bg_1"]);
    expect(reg.listEntries("s2")).toEqual([]); // scope isolation
  });

  test("partial text accumulates capped", () => {
    reg.registerEntry(processEntry("bg_1", "s1"));
    reg.appendEntryPartial("bg_1", "hello ");
    reg.appendEntryPartial("bg_1", "world");
    expect(reg.getEntry("bg_1")?.partialText).toBe("hello world");
  });

  test("updateEntry patches status and output", () => {
    reg.registerEntry(processEntry("bg_1", "s1"));
    reg.updateEntry("bg_1", {
      status: "completed",
      finishedAt: Date.now(),
      exitCode: 0,
      output: "hi",
    });
    expect(reg.getEntry("bg_1")?.status).toBe("completed");
    expect(reg.getEntry("bg_1")?.exitCode).toBe(0);
  });

  test("stopEntry kills process entries via their kill callback", () => {
    let killed = 0;
    reg.registerEntry({ ...processEntry("bg_1", "s1"), kill: () => killed++ });
    expect(reg.stopEntry("bg_1").ok).toBe(true);
    expect(killed).toBe(1);
    expect(reg.stopEntry("missing").ok).toBe(false);
  });

  test("stopEntry rejects subagent ids (executor owns that stop)", () => {
    reg.registerEntry({
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
    const out = reg.stopEntry("sub-1");
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("delegation executor");
  });

  test("waitEntries resolves when jobs settle and times out otherwise", async () => {
    const a = processEntry("bg_1", "s1");
    const b = processEntry("bg_2", "s1");
    reg.registerEntry(a);
    reg.registerEntry(b);
    a.resolve();
    reg.updateEntry("bg_1", { status: "completed", finishedAt: Date.now() });
    const done = await reg.waitEntries({ scope: "s1", timeoutMs: 2000 });
    expect(done.settled.map((r) => r.id)).toEqual(["bg_1"]);
    expect(done.timedOut).toBe(false);
    const stuck = await reg.waitEntries({ ids: ["bg_2"], scope: "s1", timeoutMs: 50 });
    expect(stuck.timedOut).toBe(true);
  });
  test("registerEntry rejects process jobs past the running cap", () => {
    for (let i = 0; i < 32; i++) {
      const e = processEntry(`bg_${i}`, "s1");
      reg.registerEntry({ ...e, settle: e.settle });
    }
    const extra = processEntry("bg_x", "s1");
    const out = reg.registerEntry({ ...extra, settle: extra.settle });
    expect(out.ok).toBe(false);
    expect(String((out as { error: string }).error)).toContain("too many running jobs");
  });
});

describe("registry instances", () => {
  test("two instances never share entries (per-Run isolation)", () => {
    const a = createCoordinationRegistry();
    const b = createCoordinationRegistry();
    const e = processEntry("bg_iso", "s1");
    a.registerEntry(e);
    expect(a.getEntry("bg_iso")).toBeDefined();
    expect(b.getEntry("bg_iso")).toBeUndefined();
    expect(b.listEntries("s1")).toEqual([]);
    a.clearAll();
    expect(a.getEntry("bg_iso")).toBeUndefined();
  });
});
