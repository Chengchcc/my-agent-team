import { describe, expect, test } from "bun:test";
import { CapabilityRegistry } from "./registry.js";
import type { Capability } from "./types.js";

function makeCap(id: string): Capability {
  return {
    id,
    extendAgent: () => ({ systemPrompt: `prompt-${id}` }),
  };
}

describe("CapabilityRegistry", () => {
  test("empty registry is valid", () => {
    const reg = new CapabilityRegistry();
    expect(reg.list().length).toBe(0);
  });

  test("install order is deterministic", () => {
    const reg = new CapabilityRegistry();
    reg.register(makeCap("a"));
    reg.register(makeCap("b"));
    reg.register(makeCap("c"));
    expect(reg.list().map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  test("duplicate ids are rejected", () => {
    const reg = new CapabilityRegistry();
    reg.register(makeCap("x"));
    expect(() => reg.register(makeCap("x"))).toThrow("Duplicate");
  });

  test("collectExtensions merges system prompts in order", () => {
    const reg = new CapabilityRegistry();
    reg.register(makeCap("a"));
    reg.register(makeCap("b"));
    const ext = reg.collectExtensions();
    expect(ext.systemPrompt).toContain("prompt-a");
    expect(ext.systemPrompt).toContain("prompt-b");
  });

  test("collectExtensions rejects tool name collisions", () => {
    const reg = new CapabilityRegistry();
    reg.register({
      id: "x",
      extendAgent: () => ({
        tools: [{ name: "dup", description: "desc", inputSchema: {} } as const],
      }),
    });
    reg.register({
      id: "y",
      extendAgent: () => ({
        tools: [{ name: "dup", description: "desc", inputSchema: {} } as const],
      }),
    });
    expect(() => reg.collectExtensions()).toThrow("Tool name collision");
  });

  test("getManifests returns all manifests", () => {
    const reg = new CapabilityRegistry();
    reg.register({ id: "a", manifest: { id: "a", slots: ["conversation:sidebar"] } });
    reg.register({ id: "b" });
    const m = reg.getManifests();
    expect(m.length).toBe(2);
    expect(m[0]?.slots).toEqual(["conversation:sidebar"]);
    expect(m[1]?.slots).toBeUndefined();
  });
});
