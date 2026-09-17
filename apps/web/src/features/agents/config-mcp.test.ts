import { describe, expect, test } from "bun:test";
import { agentConfigToDraft } from "@/features/agents/config-mcp";

/** The create page adopts a chat-proposed config into its form. The mapper is
 *  the boundary: it must carry the modelling choices and DROP anything that
 *  could leak another agent's identity/workspace/credentials into a new one. */

const proposed = {
  name: "Code Reviewer",
  enabled: true,
  runtime_config: {
    runtime: "oma",
    model_id: "anthropic/claude-sonnet-4-6",
    reasoning_effort: "high",
    permission_mode: "auto",
    max_steps: 40,
    mcp_servers: [{ server_id: "mcp-1", enabled: true }],
    knowledge_packs: ["kp-1"],
  },
  lark: { enabled: true, app_id: "cli_x", bot_display_name: "reviewer-bot" },
};

describe("agentConfigToDraft", () => {
  test("maps the modelling choices the form consumes", () => {
    expect(agentConfigToDraft(proposed)).toEqual({
      name: "Code Reviewer",
      backendKind: "oma",
      modelProvider: "anthropic",
      modelName: "claude-sonnet-4-6",
      reasoningEffort: "high",
      permissionMode: "auto",
      maxSteps: 40,
      mcpServers: [{ serverId: "mcp-1", enabled: true }],
      knowledgePacks: ["kp-1"],
    });
  });

  test("drops lark credentials and any workspace/identity fields", () => {
    const draft = agentConfigToDraft({
      ...proposed,
      workspacePath: "/tmp/somebody-elses-workspace",
      id: "other-agent",
    });
    const keys = Object.keys(draft as Record<string, unknown>);
    expect(keys).not.toContain("lark");
    expect(keys).not.toContain("workspacePath");
    expect(keys).not.toContain("id");
  });

  test("survives a sparse or malformed proposal", () => {
    expect(agentConfigToDraft({})).toEqual({
      modelProvider: "",
      modelName: "",
      maxSteps: null,
      mcpServers: [],
      knowledgePacks: [],
    });
    expect(agentConfigToDraft(null)).toEqual({
      modelProvider: "",
      modelName: "",
      maxSteps: null,
      mcpServers: [],
      knowledgePacks: [],
    });
  });
});
