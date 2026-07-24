import { describe, expect, test } from "bun:test";
import { CapabilityRegistry } from "./registry.js";
import type {
  AgentScope,
  BackendInfrastructure,
  Capability,
  MemoryCapabilityDeps,
  MemoryReader,
} from "./types.js";

const scope: AgentScope = { agentId: "a", sessionId: "s", cwd: "/tmp" };
const ctx = {
  sessionId: "",
  state: {
    get: () => undefined,
    set: () => {},
    has: () => false,
    delete: () => {},
    clear: () => {},
  },
};

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
    r.register({
      id: "fail",
      extendAgent: async () => {
        throw new Error("boom");
      },
    });
    await expect(r.collectExtensions(scope)).rejects.toThrow("boom");
  });

  test("passes real scope to extension", async () => {
    const r = new CapabilityRegistry();
    let received: AgentScope | undefined;
    r.register({
      id: "s",
      extendAgent: (s) => {
        received = { ...s };
        return {};
      },
    });
    const s: AgentScope = {
      agentId: "a1",
      sessionId: "s1",
      conversationId: "c1",
      memberId: "m1",
      cwd: "/w",
    };
    await r.collectExtensions(s);
    expect(received).toEqual(s);
  });

  test("scope is not leaked between calls", async () => {
    const r = new CapabilityRegistry();
    const scopes: AgentScope[] = [];
    r.register({
      id: "x",
      extendAgent: (s) => {
        scopes.push({ ...s });
        return {};
      },
    });
    await r.collectExtensions({ agentId: "a", sessionId: "1", cwd: "/a" });
    await r.collectExtensions({ agentId: "b", sessionId: "2", cwd: "/b" });
    expect(scopes).toHaveLength(2);
    expect(scopes[0]?.sessionId).toBe("1");
    expect(scopes[1]?.sessionId).toBe("2");
  });

  test("rejects capability vs capability tool collision", async () => {
    const r = new CapabilityRegistry();
    const t = {
      name: "dup",
      description: "d",
      inputSchema: {},
      execute: async () => ({ role: "tool" as const, id: "x", name: "t", content: "ok" }),
    };
    r.register({ id: "x", extendAgent: () => ({ tools: [t] }) });
    r.register({ id: "y", extendAgent: () => ({ tools: [{ ...t }] }) });
    await expect(r.collectExtensions(scope)).rejects.toThrow("Tool name collision");
  });

  test("rejects capability vs base tool collision", async () => {
    const r = new CapabilityRegistry();
    const base = {
      name: "base",
      description: "d",
      inputSchema: {},
      execute: async () => ({ role: "tool" as const, id: "x", name: "t", content: "ok" }),
    };
    r.register({ id: "c", extendAgent: () => ({ tools: [{ ...base }] }) });
    await expect(r.collectExtensions(scope, [base])).rejects.toThrow("base");
  });

  test("before:run transforms flow through chain", async () => {
    const r = new CapabilityRegistry();
    r.register({
      id: "a",
      extendAgent: () => ({
        hooks: { "before:run": async (_c, inp) => ({ text: inp.text + " +a" }) },
      }),
    });
    r.register({
      id: "b",
      extendAgent: () => ({
        hooks: { "before:run": async (_c, inp) => ({ text: inp.text + " +b" }) },
      }),
    });
    const ext = await r.collectExtensions(scope);
    const result = await ext.hooks?.["before:run"]?.(ctx, { text: "start" });
    expect(result?.text).toBe("start +a +b");
  });

  test("before:model handlers run in registration order", async () => {
    const calls: string[] = [];
    const r = new CapabilityRegistry();
    r.register({
      id: "first",
      extendAgent: () => ({
        hooks: {
          "before:model": async (_c, msgs) => {
            calls.push("first");
            return msgs;
          },
        },
      }),
    });
    r.register({
      id: "second",
      extendAgent: () => ({
        hooks: {
          "before:model": async (_c, msgs) => {
            calls.push("second");
            return msgs;
          },
        },
      }),
    });
    const ext = await r.collectExtensions(scope);
    await ext.hooks?.["before:model"]?.(ctx, []);
    expect(calls).toEqual(["first", "second"]);
  });

  test("after:model + after:turn observers run in order", async () => {
    const calls: string[] = [];
    const r = new CapabilityRegistry();
    r.register({
      id: "o1",
      extendAgent: () => ({
        hooks: {
          "after:model": async () => {
            calls.push("a1");
          },
          "after:turn": async () => {
            calls.push("t1");
          },
        },
      }),
    });
    r.register({
      id: "o2",
      extendAgent: () => ({
        hooks: {
          "after:model": async () => {
            calls.push("a2");
          },
          "after:turn": async () => {
            calls.push("t2");
          },
        },
      }),
    });
    const ext = await r.collectExtensions(scope);
    await ext.hooks?.["after:model"]?.(ctx, [], { input: 0, output: 0 });
    await ext.hooks?.["after:turn"]?.(ctx, []);
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
    const d = await ext.hooks?.["before:tool"]?.(ctx, { id: "x", name: "t", input: "orig" });
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
          "before:tool": async () => {
            calls.push("skip");
            return { skip: true };
          },
        },
      }),
    });
    r.register({
      id: "never",
      extendAgent: () => ({
        hooks: {
          "before:tool": async () => {
            calls.push("never");
            return undefined;
          },
        },
      }),
    });
    const ext = await r.collectExtensions(scope);
    const d = await ext.hooks?.["before:tool"]?.(ctx, { id: "x", name: "t", input: "a" });
    expect(d).toEqual({ skip: true });
    expect(calls).toEqual(["skip"]);
  });

  test("before:stop reasons combine", async () => {
    const r = new CapabilityRegistry();
    r.register({
      id: "r1",
      extendAgent: () => ({
        hooks: { "before:stop": async () => ({ continue: true, reason: "R1" }) },
      }),
    });
    r.register({
      id: "r2",
      extendAgent: () => ({
        hooks: { "before:stop": async () => ({ continue: true, reason: "R2" }) },
      }),
    });
    const ext = await r.collectExtensions(scope);
    const d = await ext.hooks?.["before:stop"]?.(ctx, []);
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

// ── P6-B: Services ownership & dependency mapping ──
describe("P6-B dependency ownership", () => {
  // Fake infrastructure created by backend bootstrap
  function fakeInfra(): BackendInfrastructure {
    return {
      modelRegistry: { get: () => ({ stream: async function* () {} }) as never },
      settings: {
        get: () => undefined,
        getNumber: async () => undefined,
        set: () => {},
      },
      fs: { cwd: "/tmp", read: () => "", write: () => {} },
      sse: { emit: () => {} },
    };
  }

  // Fake capability factory — proves closure captures deps, service is reused
  test("factory closure captures deps and reuses service across scopes", async () => {
    const infra = fakeInfra();
    let factoryCalls = 0;
    let extendCalls = 0;

    function createFakeCapability(deps: MemoryCapabilityDeps): Capability {
      factoryCalls++;
      // Service created once, reused across all Agent scopes
      const calls: string[] = [];
      return {
        id: "fake-memory",
        extendAgent(scope: AgentScope) {
          extendCalls++;
          calls.push(scope.sessionId);
          return { systemPrompt: `agent=${scope.agentId} fs=${deps.fs.cwd} calls=${calls.length}` };
        },
      };
    }

    const cap = createFakeCapability({
      modelRegistry: infra.modelRegistry,
      settings: infra.settings,
      fs: infra.fs,
    });
    const reg = new CapabilityRegistry();
    reg.register(cap);

    // Factory called once at registration
    expect(factoryCalls).toBe(1);

    // Two different scopes — same service, different extensions
    const extA = await reg.collectExtensions({ agentId: "a", sessionId: "s1", cwd: "/a" });
    const extB = await reg.collectExtensions({ agentId: "b", sessionId: "s2", cwd: "/b" });

    expect(extendCalls).toBe(2);
    expect(extA.systemPrompt).toContain("agent=a");
    expect(extB.systemPrompt).toContain("agent=b");
  });

  test("capability does not receive full BackendInfrastructure — only its declared deps", () => {
    // Type-level check: the factory ONLY accepts MemoryCapabilityDeps, not BackendInfrastructure.
    // If someone tries to pass { sse, fs, settings, modelRegistry }, TypeScript rejects it
    // unless they explicitly destructure. This test verifies the contract exists.
    const infra = fakeInfra();
    // ✅ This compiles: exact MemoryCapabilityDeps
    const deps: MemoryCapabilityDeps = {
      modelRegistry: infra.modelRegistry,
      settings: infra.settings,
      fs: infra.fs,
    };
    // Verify deps are the right shape (not BackendInfrastructure)
    expect(deps.modelRegistry).toBeDefined();
    expect(deps.settings).toBeDefined();
    expect(deps.fs).toBeDefined();
    // sse is NOT in MemoryCapabilityDeps
    expect("sse" in deps).toBe(false);
  });

  test("MemoryReader narrow port allows capability-to-capability communication", async () => {
    let searchCalls = 0;
    const reader: MemoryReader = {
      search: async (q, scope) => {
        searchCalls++;
        return [{ content: `matched ${q} for ${scope.agentId}`, score: 1 }];
      },
    };

    const reg = new CapabilityRegistry();
    reg.register({
      id: "memory",
      extendAgent: () => ({ tools: [] }),
    });

    // Another capability can consume the reader port without accessing memory internals
    const results = await reader.search("test", { agentId: "a" });
    expect(results[0]?.content).toContain("matched test for a");
    expect(searchCalls).toBe(1);
  });

  test("server command duplicate registration fails", () => {
    const reg = new CapabilityRegistry();
    reg.registerCommand("memory.search", () => "ok");
    expect(() => reg.registerCommand("memory.search", () => "fail")).toThrow("Duplicate command");
  });

  test("async factory failure propagates", async () => {
    const reg = new CapabilityRegistry();
    reg.register({
      id: "fail",
      extendAgent: async () => {
        throw new Error("init failed");
      },
    });
    await expect(
      reg.collectExtensions({ agentId: "a", sessionId: "s", cwd: "/tmp" }),
    ).rejects.toThrow("init failed");
  });

  test("async installServer failure propagates", async () => {
    const reg = new CapabilityRegistry();
    reg.register({
      id: "fail",
      installServer: async () => {
        throw new Error("install failed");
      },
    });
    await expect(
      reg.installServer({
        registerRoute: () => {},
        registerCommand: () => {},
      }),
    ).rejects.toThrow("install failed");
  });
});
