import { describe, expect, test } from "bun:test";
import {
  agentUpdateFromConfig,
  applyProposal,
  type ProjectPatch,
  ProposalNotApplicable,
  projectPatchFrom,
  reviewedPayload,
  sameJson,
} from "./apply.js";

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

  test("a workflow proposal is adopted only when the saved definition IS the proposal", async () => {
    const proposal = { name: "nightly", nodes: [{ id: "a" }], edges: [] };
    const base = { updateAgent: async () => {}, createProject: async () => "p" };
    // The editor saved the proposal as it was (key order is not a difference): adopted.
    await applyProposal({
      kind: "workflow_definition",
      targetId: "w1",
      payload: proposal,
      deps: {
        ...base,
        readWorkflowDefinition: async () => ({ edges: [], nodes: [{ id: "a" }], name: "nightly" }),
      },
    });
    // The person changed the graph before saving: that document is not this proposal.
    await expect(
      applyProposal({
        kind: "workflow_definition",
        targetId: "w1",
        payload: proposal,
        deps: { ...base, readWorkflowDefinition: async () => ({ ...proposal, name: "changed" }) },
      }),
    ).rejects.toBeInstanceOf(ProposalNotApplicable);
    // No saved definition, or no way to read one: refused, and the row stays pending.
    await expect(
      applyProposal({
        kind: "workflow_definition",
        targetId: "w1",
        payload: proposal,
        deps: { ...base, readWorkflowDefinition: async () => null },
      }),
    ).rejects.toBeInstanceOf(ProposalNotApplicable);
  });

  test("the same document whatever the key order; a different array is a different document", () => {
    expect(sameJson({ a: 1, b: [1, { d: 2, c: 3 }] }, { b: [1, { c: 3, d: 2 }], a: 1 })).toBe(true);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson(null, undefined)).toBe(false);
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

  test("a project change reaches the project applier as a patch of the named fields only", async () => {
    const seen: Array<[string, ProjectPatch]> = [];
    await applyProposal({
      kind: "project_update",
      targetId: "p1",
      payload: { projectId: "p1", name: "Renamed", proposedBy: "pa" },
      deps: {
        updateAgent: async () => {},
        createProject: async () => "p",
        updateProject: async (id, patch) => {
          seen.push([id, patch]);
        },
      },
    });
    expect(seen).toEqual([["p1", { name: "Renamed" }]]);
  });

  test("a project change nothing can apply is refused, not marked", async () => {
    await expect(
      applyProposal({
        kind: "project_update",
        targetId: "p1",
        payload: { name: "Renamed" },
        deps: { updateAgent: async () => {}, createProject: async () => "p" },
      }),
    ).rejects.toBeInstanceOf(ProposalNotApplicable);
  });
});

describe("a reviewed project payload", () => {
  test("an empty repository or branch clears it; a field not named is left alone", () => {
    expect(projectPatchFrom({ repoUrl: "", defaultBranch: "dev", proposedBy: "pa" })).toEqual({
      repoUrl: null,
      defaultBranch: "dev",
    });
  });

  test("the values the human saved replace the tool's for a project, and only those", () => {
    const reviewed = reviewedPayload(
      "project_update",
      { projectId: "p1", name: "tool", proposedBy: "pa" },
      { name: "human", projectId: "p2" },
    );
    expect(reviewed).toEqual({ projectId: "p1", name: "human", proposedBy: "pa" });
  });

  test("a new project keeps the members the tool named unless the form names others", () => {
    const stored = { name: "a", repoUrl: "u", attachTo: ["w1"] };
    expect(reviewedPayload("project_creation", stored, { name: "b" })).toEqual({
      ...stored,
      name: "b",
    });
    expect(reviewedPayload("project_creation", stored, { attachTo: ["w2", ""] })).toEqual({
      ...stored,
      attachTo: ["w2"],
    });
  });

  test("other kinds keep the stored payload, whatever the page sends", () => {
    const stored = { name: "x" };
    expect(reviewedPayload("agent_config", stored, { name: "y" })).toBe(stored);
  });

  test("no override means the stored payload", () => {
    expect(reviewedPayload("project_update", { name: "x" }, undefined)).toEqual({ name: "x" });
  });
});
