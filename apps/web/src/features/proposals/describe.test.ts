import { describe, expect, test } from "bun:test";
import { describeProposal, proposalTitle } from "./describe";
import { appliesFromInbox, owningEditorHref, PROPOSAL_KINDS, resourcePageHref } from "./queries";

const names = { agentNameOf: (agentId: string) => `name:${agentId}` };

describe("proposal routing", () => {
  test("every kind is listed, once", () => {
    expect(new Set(PROPOSAL_KINDS).size).toBe(PROPOSAL_KINDS.length);
  });

  test("agent and workflow proposals are reviewed in the editor that owns their target", () => {
    expect(owningEditorHref({ kind: "agent_config", targetId: "coder" })).toBe("/team/coder/edit");
    expect(owningEditorHref({ kind: "workflow_definition", targetId: "wiki-lint" })).toBe(
      "/workflows/wiki-lint?edit=1",
    );
  });

  test("project and workflow proposals can be applied from the inbox", () => {
    expect(owningEditorHref({ kind: "project_creation", targetId: "new" })).toBeNull();
    expect(owningEditorHref({ kind: "project_update", targetId: "p1" })).toBeNull();
    expect(appliesFromInbox({ kind: "project_update", targetId: "p1" })).toBeTruthy();
    expect(appliesFromInbox({ kind: "agent_config", targetId: "a1" })).toBeFalsy();
    expect(appliesFromInbox({ kind: "workflow_definition", targetId: "w1" })).toBeTruthy();
  });

  test("the project page is where both project kinds can be looked at", () => {
    expect(resourcePageHref("project_creation")).toBe("/team/projects");
    expect(resourcePageHref("project_update")).toBe("/team/projects");
    expect(resourcePageHref("agent_config")).toBeNull();
    expect(resourcePageHref("workflow_definition")).toBeNull();
  });
});

describe("describeProposal", () => {
  test("an agent-config proposal reads as the fields the applier writes", () => {
    const lines = describeProposal(
      "agent_config",
      {
        name: "Coder",
        role: "worker",
        runtime_config: { model: "oma/deep", permission_mode: "auto", projects: ["p1", "p2"] },
      },
      names,
    );
    expect(lines).toEqual([
      "name: Coder",
      "role: worker",
      "model: oma/deep",
      "permission: auto",
      "projects: 2 item(s)",
    ]);
  });

  test("a workflow proposal counts its graph and names its schedule", () => {
    const lines = describeProposal(
      "workflow_definition",
      {
        meta: { name: "Lint", description: "Nightly lint", status: "draft" },
        nodes: [{ id: "start" }, { id: "end" }],
        edges: [{ from: "start", to: "end" }],
        triggers: [{ type: "cron", cron: "0 4 * * *" }],
      },
      names,
    );
    expect(lines).toEqual([
      "2 node(s) · 1 edge(s)",
      "schedule: 0 4 * * *",
      "description: Nightly lint",
      "status: draft",
    ]);
    expect(proposalTitle("workflow_definition", { meta: { name: "Lint" } })).toBe("Lint");
  });

  test("a workflow without a trigger says it is manual", () => {
    expect(describeProposal("workflow_definition", { nodes: [], edges: [] }, names)).toEqual([
      "0 node(s) · 0 edge(s)",
      "schedule: none (manual)",
    ]);
  });

  test("an ADR 0084 wrapped workflow proposal shows approval reasons and title", () => {
    const wrapped = {
      definition: {
        meta: { name: "Nightly Audit", description: "Checks repo", status: "active" },
        nodes: [{ id: "start" }, { id: "s1", type: "script", code: "return { ok: true }" }],
        edges: [{ from: "start", to: "s1" }],
        triggers: [{ type: "cron", cron: "0 3 * * *", enabled: true }],
      },
      requiresApprovalFor: ["script", "cron"],
      summary: "add nightly check",
    };
    expect(describeProposal("workflow_definition", wrapped, names)).toEqual([
      "2 node(s) · 1 edge(s)",
      "requires approval: script, cron",
      "schedule: 0 3 * * *",
      "summary: add nightly check",
      "description: Checks repo",
      "status: active",
    ]);
    expect(proposalTitle("workflow_definition", wrapped)).toBe("Nightly Audit");
  });

  test("a project proposal names its repository, branch and holders", () => {
    const lines = describeProposal(
      "project_creation",
      { name: "Agent Workspace", repoUrl: "git@x/y.git", attachTo: ["coder", "researcher"] },
      names,
    );
    expect(lines).toEqual([
      "name: Agent Workspace",
      "repository: git@x/y.git",
      "holders: name:coder, name:researcher",
    ]);
    expect(proposalTitle("project_creation", { name: "Agent Workspace" })).toBe("Agent Workspace");
  });

  test("a project change that empties a field says it clears it", () => {
    expect(describeProposal("project_update", { repoUrl: "", defaultBranch: "" }, names)).toEqual([
      "repository: cleared",
      "branch: cleared",
    ]);
  });

  test("a shape nobody recognises still shows its keys, and a non-object shows nothing", () => {
    expect(describeProposal("project_update", { other: 7 }, names)).toEqual([]);
    expect(describeProposal("project_update", "text", names)).toEqual([]);
    expect(describeProposal("agent_config", "text", names)).toEqual([]);
    expect(proposalTitle("project_creation", 42)).toBeNull();
  });
});
