import { describe, expect, test } from "bun:test";
import { safeAgentId } from "./safe-agent-id.js";

describe("sender profile naming", () => {
  test("safeAgentId produces safe slug with hash suffix", () => {
    const id = safeAgentId("agent-123");
    expect(id).toMatch(/^agent-123-[a-f0-9]{8}$/);
    expect(safeAgentId("my_agent_42")).toMatch(/^my_agent_42-[a-f0-9]{8}$/);
  });

  test("safeAgentId replaces special chars with underscore", () => {
    const id = safeAgentId("agent/with:special");
    expect(id).toMatch(/^agent_with_special-[a-f0-9]{8}$/);
    expect(safeAgentId("test agent!")).toMatch(/^test_agent_-[a-f0-9]{8}$/);
    expect(safeAgentId("a@b#c$d%")).toMatch(/^a_b_c_d_-[a-f0-9]{8}$/);
  });

  test("different raw IDs with same slug produce different hashes", () => {
    // "foo.bar" and "foo_bar" have the same slug, different hash
    expect(safeAgentId("foo.bar")).not.toBe(safeAgentId("foo_bar"));
  });

  test("empty string produces hash-only id", () => {
    expect(safeAgentId("")).toMatch(/^-[a-f0-9]{8}$/);
  });
});
