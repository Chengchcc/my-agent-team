import { describe, expect, test } from "bun:test";
import { AGENT_DRAFT_ID } from "@chengchenccc/api-contract";
import {
  callAgentConfigTool,
  createCreateBudget,
  readAgentCreateInput,
} from "./agent-config-mcp.js";

/** The agent-config MCP surface the edit page's chat drives: propose config
 *  changes for an EXISTING agent (agent_write) and propose a new member
 *  (agent_create). */

const config = { id: "reviewer", name: "Reviewer" };

function deps(known: readonly string[] = ["reviewer"]) {
  /** What the tool ALSO recorded for a page to read later (ADR 0040). */
  const proposals: Array<{ kind: string; targetId: string; payload: unknown }> = [];
  const recorder = {
    propose: (kind: string, targetId: string, payload: unknown) => {
      proposals.push({ kind, targetId, payload });
    },
  };
  return {
    proposals,
    d: {
      readConfig: async (agentId: string) => {
        if (!known.includes(agentId)) throw new Error(`Agent not found: ${agentId}`);
        return config;
      },
      agentExists: async (agentId: string) => known.includes(agentId),
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

  test("agent_create proposes a new member instead of creating one", async () => {
    const { d, proposals } = deps();
    const text = await callAgentConfigTool(d, "agent_create", {
      name: "Code Reviewer",
      harness: "oma",
      model: "anthropic/claude-sonnet-4-6",
      permissionMode: "auto",
      reasoningEffort: "high",
    });
    // Operator decision 2026-11-24: creating a member is a human's click.
    expect(text).toContain("proposed");
    expect(text).toContain("NOT created");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.kind).toBe("agent_config");
    expect(proposals[0]!.payload).toMatchObject({ name: "Code Reviewer", harness: "oma" });
  });

  test("an agent cannot give itself an ungated sibling: yolo is admin-only", async () => {
    // yolo lifts the gate entirely. It has to be reachable for the humans who
    // run unattended workflow nodes (HTTP route + zod + runtime all accept it)
    // but NOT from a tool an agent can call: otherwise one prompt injection is
    // enough to mint an ungated agent and run anything through it.
    const { d, proposals } = deps();
    await expect(
      callAgentConfigTool(d, "agent_create", {
        name: "Unattended",
        harness: "oma",
        permissionMode: "yolo",
      }),
    ).rejects.toThrow(/permissionMode must be one of ask, auto, deny$/);
    expect(proposals).toEqual([]);
  });

  test("agent_create rejects a missing model before creating anything", async () => {
    const { d, proposals } = deps();
    await expect(callAgentConfigTool(d, "agent_create", { name: "Nameless" })).rejects.toThrow(
      /harness required/,
    );
    expect(proposals).toEqual([]);
  });

  test("agent_create rejects an unknown harness before creating anything", async () => {
    const { d, proposals } = deps();
    await expect(
      callAgentConfigTool(d, "agent_create", {
        name: "Ghost",
        harness: "ghost",
        model: "anthropic/claude-sonnet-4-6",
      }),
    ).rejects.toThrow(/unknown harness ghost/);
    expect(proposals).toEqual([]);
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
