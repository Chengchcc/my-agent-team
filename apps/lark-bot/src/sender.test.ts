import { describe, expect, test } from "bun:test";
import { safeAgentId } from "./safe-agent-id.js";

describe("sender profile naming", () => {
  test("safeAgentId preserves alphanumeric and underscores", () => {
    expect(safeAgentId("agent-123")).toBe("agent-123");
    expect(safeAgentId("my_agent_42")).toBe("my_agent_42");
  });

  test("safeAgentId replaces special chars with underscore", () => {
    expect(safeAgentId("agent/with:special")).toBe("agent_with_special");
    expect(safeAgentId("test agent!")).toBe("test_agent_");
    expect(safeAgentId("a@b#c$d%")).toBe("a_b_c_d_");
  });

  test("profile name format is agent:<safeId>", () => {
    const id = safeAgentId("my-agent");
    const profile = `agent:${id}`;
    expect(profile).toBe("agent:my-agent");
  });

  test("safeAgentId handles empty string", () => {
    expect(safeAgentId("")).toBe("");
  });
});
