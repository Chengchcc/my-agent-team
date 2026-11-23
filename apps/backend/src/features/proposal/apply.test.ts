import { describe, expect, test } from "bun:test";
import { agentUpdateFromConfig, applyProposal, ProposalNotApplicable } from "./apply.js";

describe("adoption applies the payload", () => {
  test("an agent config maps onto the update API's flat shape", () => {
    const input = agentUpdateFromConfig({
      name: "Reviewer",
      role: "worker",
      skills: [{ id: "code-review" }],
      runtime_config: {
        harness: "oma",
        model: "deepseek/deepseek-v4-pro",
        permission_mode: "auto",
        deny_write_paths: ["/x/"],
        deny_commands: ["git push"],
        projects: ["p1"],
        mcp_servers: [{ server_id: "knowledge", enabled: false }],
      },
    });
    expect(input.name).toBe("Reviewer");
    expect(input.harness).toBe("oma");
    expect(input.permissionMode).toBe("auto");
    expect(input.denyWritePaths).toEqual(["/x/"]);
    expect(input.denyCommands).toEqual(["git push"]);
    expect(input.projects).toEqual(["p1"]);
    expect(input.mcpServers).toEqual([{ serverId: "knowledge", enabled: false }]);
  });

  test("an empty agent name is not invented", () => {
    expect(agentUpdateFromConfig({ runtime_config: {} })).toEqual({});
  });

  test("agent_config reaches the applier with the target id", async () => {
    const seen: Array<[string, Record<string, unknown>]> = [];
    await applyProposal({
      kind: "agent_config",
      targetId: "a1",
      payload: { name: "Coder", runtime_config: { model: "m" } },
      deps: {
        updateAgent: async (id, input) => {
          seen.push([id, input]);
        },
        createProject: async () => "p",
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe("a1");
    expect(seen[0]?.[1].model).toBe("m");
  });

  test("a kind the deployment cannot apply is refused, not marked", async () => {
    await expect(
      applyProposal({
        kind: "workflow_definition",
        targetId: "w1",
        payload: {},
        deps: { updateAgent: async () => {}, createProject: async () => "p" },
      }),
    ).rejects.toBeInstanceOf(ProposalNotApplicable);
  });

  test("a project proposal needs a name and a repository", async () => {
    await expect(
      applyProposal({
        kind: "project_creation",
        targetId: "x",
        payload: { name: "only-a-name" },
        deps: { updateAgent: async () => {}, createProject: async () => "p" },
      }),
    ).rejects.toBeInstanceOf(ProposalNotApplicable);
  });
});
