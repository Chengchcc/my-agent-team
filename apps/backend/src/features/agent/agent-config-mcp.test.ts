import { describe, expect, test } from "bun:test";
import { AgentConfigEventBus } from "./agent-config-events.js";
import { callAgentConfigTool } from "./agent-config-mcp.js";

/** The agent-config MCP surface the edit page's chat drives. Its job is to
 *  propose config changes for an EXISTING agent — a false success here (or on
 *  an unknown id) is what makes "let the agent configure an agent" look alive
 *  while nothing can ever land. */

const config = { id: "reviewer", name: "Reviewer" };

function deps(known: readonly string[] = ["reviewer"]) {
  const events = new AgentConfigEventBus();
  return {
    events,
    d: {
      readConfig: async (agentId: string) => {
        if (!known.includes(agentId)) throw new Error(`Agent not found: ${agentId}`);
        return config;
      },
      agentExists: async (agentId: string) => known.includes(agentId),
      configEvents: events,
    },
  };
}

describe("agent-config MCP tools", () => {
  test("agent_read returns the config for a known agent", async () => {
    const { d } = deps();
    const text = await callAgentConfigTool(d, "agent_read", { agentId: "reviewer" });
    expect(JSON.parse(text).id).toBe("reviewer");
  });

  test("agent_read of an unknown agent rejects", async () => {
    const { d } = deps();
    await expect(callAgentConfigTool(d, "agent_read", { agentId: "ghost" })).rejects.toThrow(
      /not found/i,
    );
  });

  test("agent_write proposes for the edit page of an existing agent", async () => {
    const { d, events } = deps();
    const stream = events.subscribe("reviewer");
    const text = await callAgentConfigTool(d, "agent_write", {
      agentId: "reviewer",
      config: { ...config, name: "Renamed" },
    });
    expect(text).toContain("NOT saved");
    expect(text).toContain("/team/reviewer/edit");
    const ev = await stream[Symbol.asyncIterator]().next();
    expect(ev.value?.data.trigger).toBe("mcp");
  });

  test("agent_write on an unknown agent fails instead of reporting a proposal", async () => {
    const { d } = deps();
    await expect(
      callAgentConfigTool(d, "agent_write", { agentId: "ghost", config }),
    ).rejects.toThrow(/unknown agent/);
  });

  test("unknown tool is an error, not a silent success", async () => {
    const { d } = deps();
    await expect(callAgentConfigTool(d, "agent_delete", { agentId: "reviewer" })).rejects.toThrow(
      /unknown tool/,
    );
  });
});
