import { describe, expect, test } from "bun:test";
import { CapabilityRegistry } from "./registry.js";
import type { AgentScope, Capability } from "./types.js";

const scope: AgentScope = { agentId: "a", sessionId: "s", cwd: "/tmp" };

describe("CapabilityRegistry", () => {
  test("empty registry list is empty", () => {
    expect(new CapabilityRegistry().list().length).toBe(0);
  });

  test("install order is deterministic", () => {
    const r = new CapabilityRegistry();
    r.register({ id: "c" });
    r.register({ id: "a" });
    r.register({ id: "b" });
    expect(r.list().map((c) => c.id)).toEqual(["c", "a", "b"]);
  });

  test("duplicate ids rejected", () => {
    const r = new CapabilityRegistry();
    r.register({ id: "x" });
    expect(() => r.register({ id: "x" })).toThrow("Duplicate");
  });

  test("merges system prompts in registration order", async () => {
    const r = new CapabilityRegistry();
    r.register({ id: "a", extendAgent: () => ({ systemPrompt: "A" }) });
    r.register({ id: "b", extendAgent: () => ({ systemPrompt: "B" }) });
    const ext = await r.collectExtensions(scope);
    expect(ext.systemPrompt).toBe("A\n\nB");
  });

  test("awaits async extensions", async () => {
    const r = new CapabilityRegistry();
    r.register({ id: "x", extendAgent: async () => ({ systemPrompt: "async-ok" }) });
    expect((await r.collectExtensions(scope)).systemPrompt).toBe("async-ok");
  });

  test("propagates async rejection", async () => {
    const r = new CapabilityRegistry();
    r.register({ id: "fail", extendAgent: async () => { throw new Error("boom"); } });
    await expect(r.collectExtensions(scope)).rejects.toThrow("boom");
  });

  test("passes real scope to extension", async () => {
    const r = new CapabilityRegistry();
    let received: AgentScope | undefined;
    r.register({ id: "s", extendAgent: (s) => { received = { ...s }; return {}; } });
    const s: AgentScope = { agentId: "a1", sessionId: "s1", conversationId: "c1", memberId: "m1", cwd: "/w" };
    await r.collectExtensions(s);
    expect(received).toEqual(s);
  });

  test("scope is not leaked between calls", async () => {
    const r = new CapabilityRegistry();
    const scopes: AgentScope[] = [];
    r.register({ id: "x", extendAgent: (s) => { scopes.push({ ...s }); return {}; } });
    await r.collectExtensions({ agentId: "a", sessionId: "1", cwd: "/a" });
    await r.collectExtensions({ agentId: "b", sessionId: "2", cwd: "/b" });
    expect(scopes).toHaveLength(2);
    expect(scopes[0]?.sessionId).toBe("1");
    expect(scopes[1]?.sessionId).toBe("2");
  });

  test("rejects capability vs capability tool collision", async () => {
    const r = new CapabilityRegistry();
    const t = { name: "dup", description: "d", inputSchema: {}, execute: async () => ({ role: "tool" as const, id: "x", name: "t", content: "ok" }) };
    r.register({ id: "x", extendAgent: () => ({ tools: [t] }) });
    r.register({ id: "y", extendAgent: () => ({ tools: [{ ...t }] }) });
    await expect(r.collectExtensions(scope)).rejects.toThrow("Tool name collision");
  });

  test("rejects capability vs base tool collision", async () => {
    const r = new CapabilityRegistry();
    const base = { name: "base", description: "d", inputSchema: {}, execute: async () => ({ role: "tool" as const, id: "x", name: "t", content: "ok" }) };
    r.register({ id: "c", extendAgent: () => ({ tools: [{ ...base }] }) });
    await expect(r.collectExtensions(scope, [base])).rejects.toThrow("base");
  });

  test("before:run transforms flow through chain", async () => {
    const r = new CapabilityRegistry();
    r.register({ id: "a", extendAgent: () => ({ hooks: { "before:run": async (_c, inp) => ({ text: inp.text + " +a" }) } }) });
    r.register({ id: "b", extendAgent: () => ({ hooks: { "before:run": async (_c, inp) => ({ text: inp.text + " +b" }) } }) });
    const ext = await r.collectExtensions(scope);
    const result = await ext.hooks?.["before:run"]?.({ sessionId: "", state: null! as never }, { text: "start" });
    expect(result?.text).toBe("start +a +b");
  });

  test("before:model handlers run in registration order", async () => {
    const calls: string[] = [];
    const r = new CapabilityRegistry();
    r.register({ id: "first", extendAgent: () => ({ hooks: { "before:model": async (_c, msgs) => { calls.push("first"); return msgs; } } }) });
    r.register({ id: "second", extendAgent: () => ({ hooks: { "before:model": async (_c, msgs) => { calls.push("second"); return msgs; } } }) });
    const ext = await r.collectExtensions(scope);
    await ext.hooks?.["before:model"]?.({ sessionId: "", state: null! as never }, []);
    expect(calls).toEqual(["first", "second"]);
  });

  test("after:model + after:turn observers run in order", async () => {
    const calls: string[] = [];
    const r = new CapabilityRegistry();
    r.register({ id: "o1", extendAgent: () => ({ hooks: { "after:model": async () => { calls.push("a1"); }, "after:turn": async () => { calls.push("t1"); } } }) });
    r.register({ id: "o2", extendAgent: () => ({ hooks: { "after:model": async () => { calls.push("a2"); }, "after:turn": async () => { calls.push("t2"); } } }) });
    const ext = await r.collectExtensions(scope);
    await ext.hooks?.["after:model"]?.({ sessionId: "", state: null! as never }, []);
    await ext.hooks?.["after:turn"]?.({ sessionId: "", state: null! as never }, []);
    expect(calls).toEqual(["a1", "a2", "t1", "t2"]);
  });

  test("before:tool input flows to next handler", async () => {
    const received: unknown[] = [];
    const r = new CapabilityRegistry();
    r.register({
      id: "m1",
      extendAgent: () => ({
        hooks: {
          "before:tool": async (_c, c) => {
            received.push(c.input);
            return c.input === "orig" ? { input: "mod" } : undefined;
          },
        },
      }),
    });
    r.register({
      id: "m2",
      extendAgent: () => ({
        hooks: {
          "before:tool": async (_c, c) => {
            received.push(c.input);
            return c.input === "mod" ? { input: "conf" } : undefined;
          },
        },
      }),
    });
    const ext = await r.collectExtensions(scope);
    const d = await ext.hooks?.["before:tool"]?.({ sessionId: "", state: null! as never }, { id: "x", name: "t", input: "orig" });
    expect(d).toBeUndefined();
    expect(received).toEqual(["orig", "mod"]);
  });

  test("before:tool skip stops chain", async () => {
    const calls: string[] = [];
    const r = new CapabilityRegistry();
    r.register({
      id: "skip",
      extendAgent: () => ({
        hooks: {
          "before:tool": async () => { calls.push("skip"); return { skip: true }; },
        },
      }),
    });
    r.register({
      id: "never",
      extendAgent: () => ({
        hooks: { "before:tool": async () => { calls.push("never"); return undefined; } },
      }),
    });
    const ext = await r.collectExtensions(scope);
    const d = await ext.hooks?.["before:tool"]?.({ sessionId: "", state: null! as never }, { id: "x", name: "t", input: "a" });
    expect(d).toEqual({ skip: true });
    expect(calls).toEqual(["skip"]);
  });

  test("before:stop reasons combine", async () => {
    const r = new CapabilityRegistry();
    r.register({ id: "r1", extendAgent: () => ({ hooks: { "before:stop": async () => ({ continue: true, reason: "R1" }) } }) });
    r.register({ id: "r2", extendAgent: () => ({ hooks: { "before:stop": async () => ({ continue: true, reason: "R2" }) } }) });
    const ext = await r.collectExtensions(scope);
    const d = await ext.hooks?.["before:stop"]?.({ sessionId: "", state: null! as never }, []);
    expect(d).toEqual({ continue: true, reason: "R1\n\nR2" });
  });

  test("getManifests returns all in order", () => {
    const r = new CapabilityRegistry();
    r.register({ id: "a", manifest: { id: "a", slots: ["sidebar"] } });
    r.register({ id: "b" });
    const m = r.getManifests();
    expect(m).toHaveLength(2);
    expect(m[0]?.slots).toEqual(["sidebar"]);
    expect(m[1]?.slots).toBeUndefined();
  });
});
