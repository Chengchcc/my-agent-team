import { describe, expect, test } from "bun:test";
import { AGENT_DRAFT_ID } from "@chengchenccc/api-contract";
import {
  type AgentProxyCreateInput,
  callAgentConfigTool,
  createCreateBudget,
  readAgentCreateInput,
} from "./agent-config-mcp.js";

/** The agent-config MCP surface the edit page's chat drives: propose config
 *  changes for an EXISTING agent (agent_write) and create a real one
 *  (agent_create). A false success here — a proposal with no page to adopt
 *  it, or a "created" agent that has no row — is what makes "let the agent
 *  manage agents" look alive while nothing can land. */

const config = { id: "reviewer", name: "Reviewer" };

function deps(known: readonly string[] = ["reviewer"]) {
  /** What the tool ALSO recorded for a page to read later (ADR 0040). */
  const proposals: Array<{ kind: string; targetId: string; payload: unknown }> = [];
  const recorder = {
    propose: (kind: string, targetId: string, payload: unknown) => {
      proposals.push({ kind, targetId, payload });
    },
  };
  const created: AgentProxyCreateInput[] = [];
  return {
    proposals,
    created,
    d: {
      readConfig: async (agentId: string) => {
        if (!known.includes(agentId)) throw new Error(`Agent not found: ${agentId}`);
        return config;
      },
      agentExists: async (agentId: string) => known.includes(agentId),
      createAgent: async (input: AgentProxyCreateInput) => {
        created.push(input);
        return { id: "ag-new" };
      },
      reserveCreate: () => {},
      proposals: recorder,
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
    const { d, proposals } = deps();
    const text = await callAgentConfigTool(d, "agent_write", {
      agentId: "reviewer",
      config: { ...config, name: "Renamed" },
    });
    expect(text).toContain("NOT saved");
    expect(text).toContain("/team/reviewer/edit");
    // The proposal is a row a closed page can still read.
    expect(proposals).toEqual([
      { kind: "agent_config", targetId: "reviewer", payload: { ...config, name: "Renamed" } },
    ]);
  });

  test("agent_write on an unknown agent fails instead of reporting a proposal", async () => {
    const { d } = deps();
    await expect(
      callAgentConfigTool(d, "agent_write", { agentId: "ghost", config }),
    ).rejects.toThrow(/unknown agent/);
  });

  test("agent_write under the draft id proposes for the create page", async () => {
    const { d, proposals } = deps();
    const text = await callAgentConfigTool(d, "agent_write", {
      agentId: AGENT_DRAFT_ID,
      config: { ...config, name: "Drafted" },
    });
    expect(text).toContain("NOT created");
    expect(text).toContain("/team/new/edit");
    expect(proposals).toEqual([
      { kind: "agent_config", targetId: AGENT_DRAFT_ID, payload: { ...config, name: "Drafted" } },
    ]);
  });

  test("agent_create creates through the service and reports the new id", async () => {
    const { d, created } = deps();
    const text = await callAgentConfigTool(d, "agent_create", {
      name: "Code Reviewer",
      harness: "oma",
      model: "anthropic/claude-sonnet-4-6",
      permissionMode: "auto",
      reasoningEffort: "high",
    });
    expect(created).toEqual([
      {
        name: "Code Reviewer",
        harness: "oma",
        model: "anthropic/claude-sonnet-4-6",
        reasoningEffort: "high",
        permissionMode: "auto",
      },
    ]);
    expect(text).toContain("created agent");
    expect(text).toContain("ag-new");
    expect(text).toContain("/team/ag-new/edit");
  });

  test("agent_create rejects a missing model before creating anything", async () => {
    const { d, created } = deps();
    await expect(callAgentConfigTool(d, "agent_create", { name: "Nameless" })).rejects.toThrow(
      /harness required/,
    );
    expect(created).toEqual([]);
  });

  test("agent_create rejects an unknown harness before creating anything", async () => {
    const { d, created } = deps();
    await expect(
      callAgentConfigTool(d, "agent_create", {
        name: "Ghost",
        harness: "ghost",
        model: "anthropic/claude-sonnet-4-6",
      }),
    ).rejects.toThrow(/unknown harness ghost/);
    expect(created).toEqual([]);
  });

  test("the create budget stops a runaway loop and refills next window", () => {
    const spend = createCreateBudget({ max: 2, windowMs: 60_000 });
    spend();
    spend();
    expect(spend).toThrow(/budget spent/);
    // A zero-length window rolls over on every call, so the guard refills.
    const rolling = createCreateBudget({ max: 1, windowMs: 0 });
    rolling();
    expect(rolling).not.toThrow();
  });

  test("readAgentCreateInput keeps only the fields it validated", () => {
    expect(
      readAgentCreateInput({
        name: "  Reviewer  ",
        harness: "oma",
        model: "anthropic/claude-sonnet-4-6",
        permissionMode: "deny",
        workspacePath: "/etc", // not accepted: the service owns the workspace
      }),
    ).toEqual({
      name: "Reviewer",
      harness: "oma",
      model: "anthropic/claude-sonnet-4-6",
      permissionMode: "deny",
    });
  });

  test("unknown tool is an error, not a silent success", async () => {
    const { d } = deps();
    await expect(callAgentConfigTool(d, "agent_delete", { agentId: "reviewer" })).rejects.toThrow(
      /unknown tool/,
    );
  });
});
