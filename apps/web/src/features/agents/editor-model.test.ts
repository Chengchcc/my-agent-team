import { describe, expect, test } from "bun:test";
import type { AgentFormValues } from "@/components/agent-form-types";
import {
  type AgentFormSource,
  agentChangesOf,
  agentFormValuesOf,
  agentRequestBody,
  isStaleSuggestion,
  proposalFieldsIntact,
  reviewedAgentPayload,
  sameChoice,
  suggestionFields,
  suggestionFromProposal,
  withSuggestion,
} from "@/features/agents/editor-model";

const ymlProposal = {
  id: "p1",
  kind: "agent_config" as const,
  targetId: "coder",
  createdAt: 1,
  payload: {
    name: "Coder",
    enabled: true,
    description: "Writes code",
    skills: [{ id: "react", description: "UI work" }],
    role: "worker",
    runtime_config: {
      harness: "oma",
      model: "deepseek/deepseek-v4",
      reasoning_effort: "high",
      permission_mode: "auto",
      max_steps: 40,
      mcp_servers: [
        { server_id: "mcp-1", enabled: true },
        { server_id: "mcp-2", enabled: false },
      ],
      projects: ["proj-a"],
      deny_write_paths: ["/etc"],
    },
    lark: { enabled: true, app_id: "cli_x", bot_display_name: "coder-bot" },
  },
};

function form(overrides: Partial<AgentFormValues> = {}): AgentFormValues {
  return {
    ...agentFormValuesOf(null),
    name: "Coder",
    harness: "oma",
    model: "deepseek/deepseek-flash",
    role: "front",
    description: "",
    workspacePath: "/data/agents/coder",
    skillPackIds: ["pack-1"],
    ...overrides,
  };
}

describe("agentChangesOf", () => {
  test("reads the agent.yml shape and names only what the payload carries", () => {
    const { changes, extras } = agentChangesOf(ymlProposal.payload);
    expect(changes).toEqual({
      name: "Coder",
      role: "worker",
      description: "Writes code",
      harness: "oma",
      model: "deepseek/deepseek-v4",
      reasoningEffort: "high",
      permissionMode: "auto",
      maxSteps: "40",
      skills: [{ id: "react", description: "UI work" }],
      mcpServerIds: ["mcp-1"],
    });
    expect(extras.map((extra) => extra.value)).toEqual(["proj-a", "/etc"]);
  });

  test("never carries the switch, the Lark entry or a workspace into the form", () => {
    const keys = Object.keys(agentChangesOf(ymlProposal.payload).changes);
    expect(keys).not.toContain("enabled");
    expect(keys).not.toContain("lark");
    expect(keys).not.toContain("workspacePath");
    expect(keys).not.toContain("enableLark");
    expect(keys).not.toContain("skillPackIds");
  });

  test("reads the flat shape agent_create sends", () => {
    const { changes, extras } = agentChangesOf({
      name: "Code Reviewer",
      harness: "oma",
      model: "deepseek/deepseek-v4",
      reasoningEffort: "high",
      permissionMode: "auto",
    });
    expect(changes).toEqual({
      name: "Code Reviewer",
      harness: "oma",
      model: "deepseek/deepseek-v4",
      reasoningEffort: "high",
      permissionMode: "auto",
    });
    expect(extras).toHaveLength(0);
  });

  test("drops values the form cannot hold", () => {
    const { changes } = agentChangesOf({
      name: "  ",
      role: "bot",
      runtime_config: {
        permission_mode: "yolo-typo",
        reasoning_effort: "ultra",
        max_steps: 0,
        mcp_servers: "nope",
      },
    });
    expect(Object.keys(changes)).toHaveLength(0);
  });
});

describe("suggestionFromProposal", () => {
  test("is no suggestion when nothing a save would write is named", () => {
    const empty = { ...ymlProposal, payload: { enabled: true, lark: { enabled: true } } };
    expect(suggestionFromProposal(empty, form())).toBeNull();
    expect(suggestionFromProposal({ ...ymlProposal, payload: null }, form())).toBeNull();
  });

  test("keeps the form as it was when the suggestion arrived", () => {
    const current = form({ name: "Before" });
    const suggestion = suggestionFromProposal(ymlProposal, current);
    expect(suggestion?.baseline.name).toBe("Before");
    expect(suggestion?.proposalId).toBe("p1");
  });
});

describe("withSuggestion", () => {
  test("fills the named fields and leaves the rest of the form alone", () => {
    const suggestion = suggestionFromProposal(ymlProposal, form());
    if (suggestion === null) throw new Error("expected a suggestion");
    const next = withSuggestion(form(), suggestion);
    expect(next.model).toBe("deepseek/deepseek-v4");
    expect(next.mcpServerIds).toEqual(["mcp-1"]);
    expect(next.workspacePath).toBe("/data/agents/coder");
    expect(next.skillPackIds).toEqual(["pack-1"]);
    expect(next.enableLark).toBe("off");
  });
});

describe("isStaleSuggestion", () => {
  test("a form edited after the suggestion arrived makes it stale", () => {
    const atArrival = form();
    const suggestion = suggestionFromProposal(ymlProposal, atArrival);
    if (suggestion === null) throw new Error("expected a suggestion");
    expect(isStaleSuggestion(atArrival, suggestion)).toBeFalsy();
    expect(isStaleSuggestion(form({ description: "typed since" }), suggestion)).toBeTruthy();
  });
  test("a field no suggestion can fill does not make it stale", () => {
    const atArrival = form();
    const suggestion = suggestionFromProposal(ymlProposal, atArrival);
    if (suggestion === null) throw new Error("expected a suggestion");
    const larkToggled = form({ enableLark: "on", skillPackIds: ["pack-2"] });
    expect(isStaleSuggestion(larkToggled, suggestion)).toBeFalsy();
  });

  test("the same ids in another order are the same choice", () => {
    const a = form({ mcpServerIds: ["mcp-1", "mcp-2"] }).mcpServerIds;
    const b = form({ mcpServerIds: ["mcp-2", "mcp-1"] }).mcpServerIds;
    const oneOnly = form({ mcpServerIds: ["mcp-1"] }).mcpServerIds;
    expect(sameChoice(a, b)).toBeTruthy();
    expect(sameChoice(a, oneOnly)).toBeFalsy();
  });
});

describe("proposalFieldsIntact", () => {
  test("holds while the named fields keep the suggested values", () => {
    const suggestion = suggestionFromProposal(ymlProposal, form());
    if (suggestion === null) throw new Error("expected a suggestion");
    const applied = withSuggestion(form(), suggestion);
    expect(proposalFieldsIntact(applied, suggestion)).toBeTruthy();
  });

  test("a field the suggestion did not name does not count as changing it", () => {
    const suggestion = suggestionFromProposal(ymlProposal, form());
    if (suggestion === null) throw new Error("expected a suggestion");
    const applied = withSuggestion(form(), suggestion);
    const larkToggled = { ...applied, enableLark: "on" as const, workspacePath: "/elsewhere" };
    expect(proposalFieldsIntact(larkToggled, suggestion)).toBeTruthy();
  });

  test("breaks when the person changed one of the suggested values", () => {
    const suggestion = suggestionFromProposal(ymlProposal, form());
    if (suggestion === null) throw new Error("expected a suggestion");
    const applied = withSuggestion(form(), suggestion);
    const reviewed = { ...applied, model: "deepseek/deepseek-flash" };
    expect(proposalFieldsIntact(reviewed, suggestion)).toBeFalsy();
  });
});

describe("reviewedAgentPayload and suggestionFields", () => {
  test("the reviewed payload carries the form's values for every field a suggestion can name", () => {
    const payload = reviewedAgentPayload(form({ name: "Reviewed" }));
    expect(payload.name).toBe("Reviewed");
    expect(payload.workspacePath).toBeUndefined();
    expect(Object.keys(payload)).toHaveLength(10);
  });

  test("the card lists the named fields beside the form, then the registry-only changes", () => {
    const suggestion = suggestionFromProposal(ymlProposal, form());
    if (suggestion === null) throw new Error("expected a suggestion");
    const fields = suggestionFields(form(), suggestion);
    const labels = fields.map((field) => field.label);
    expect(labels[0]).toBe("Name");
    expect(labels).toContain("Projects");
    const model = fields.find((field) => field.label === "Model");
    expect(model?.current).toBe("deepseek/deepseek-flash");
    expect(model?.proposed).toBe("deepseek/deepseek-v4");
    const projects = fields.find((field) => field.label === "Projects");
    expect(projects?.current).toBe("Not available");
    expect(projects?.proposed).toBe("proj-a");
  });

  test("the saved member's projects stand in for the current value", () => {
    const suggestion = suggestionFromProposal(ymlProposal, form());
    if (suggestion === null) throw new Error("expected a suggestion");
    const saved: AgentFormSource = {
      name: "Coder",
      harness: "oma",
      permissionMode: "auto",
      projects: ["proj-old", "proj-b"],
    };
    const fields = suggestionFields(form(), suggestion, saved);
    const projects = fields.find((field) => field.label === "Projects");
    expect(projects?.current).toBe("proj-old, proj-b");
  });
});

describe("agentFormValuesOf", () => {
  const row: AgentFormSource = {
    name: "Coder",
    description: null,
    skills: [{ id: "react", description: null }],
    role: "worker",
    harness: "oma",
    model: "deepseek/deepseek-flash",
    reasoningEffort: "low",
    permissionMode: "auto",
    maxSteps: 12,
    workspacePath: "/data/agents/coder",
    mcpServers: [
      { serverId: "mcp-1", enabled: true },
      { serverId: "mcp-2", enabled: false },
    ],
    projects: ["proj-a"],
    lark: { enabled: true, botDisplayName: "coder-bot" },
  };

  test("a new member starts from the blank form", () => {
    expect(agentFormValuesOf(null)).toEqual(agentFormValuesOf(null));
    expect(agentFormValuesOf(null).name).toBe("");
    expect(agentFormValuesOf(null).enableLark).toBe("off");
  });

  test("a saved member fills the form; only switched-on servers count", () => {
    const values = agentFormValuesOf(row);
    expect(values.name).toBe("Coder");
    expect(values.role).toBe("worker");
    expect(values.reasoningEffort).toBe("low");
    expect(values.maxSteps).toBe("12");
    expect(values.enableLark).toBe("on");
    expect(values.botDisplayName).toBe("coder-bot");
    expect(values.mcpServerIds).toEqual(["mcp-1"]);
    expect(values.skills).toEqual([{ id: "react", description: "" }]);
  });

  test("a legacy row without a role reads as a PA", () => {
    const values = agentFormValuesOf({ ...row, role: null, maxSteps: null, lark: null });
    expect(values.role).toBe("front");
    expect(values.maxSteps).toBe("");
    expect(values.enableLark).toBe("off");
  });
});

describe("agentRequestBody", () => {
  const catalog = [{ serverId: "mcp-1" }, { serverId: "mcp-2" }, { serverId: "mcp-3" }];
  const saved: AgentFormSource = {
    name: "Coder",
    description: "old",
    skills: [{ id: "react", description: "" }],
    role: "worker",
    harness: "oma",
    model: "",
    reasoningEffort: null,
    permissionMode: "ask",
    maxSteps: null,
    workspacePath: "/data/agents/coder",
    mcpServers: [
      { serverId: "mcp-1", enabled: true },
      { serverId: "mcp-2", enabled: false },
      { serverId: "gone", enabled: true },
    ],
    projects: [],
    lark: { enabled: true, botDisplayName: null },
  };

  test("a new member: no max steps, no path, only the chosen servers, the Lark entry as picked", () => {
    const body = agentRequestBody(
      form({
        maxSteps: "30",
        workspacePath: "",
        enableLark: "on",
        botDisplayName: "bot",
        mcpServerIds: ["mcp-2"],
      }),
      null,
      catalog,
    );
    expect(body.maxSteps).toBeUndefined();
    expect(body.workspacePath).toBeUndefined();
    expect(body.mcpServers).toEqual([{ serverId: "mcp-2", enabled: true }]);
    expect(body.lark).toEqual({ enabled: true, botDisplayName: "bot" });
    expect(body.reasoningEffort).toBeNull();
  });

  test("an existing member: max steps, a path only when it moved, Lark switched off when it was on", () => {
    const values = agentFormValuesOf(saved);
    const moved = agentRequestBody(
      { ...values, maxSteps: "30", workspacePath: "/data/elsewhere" },
      saved,
      catalog,
    );
    expect(moved.maxSteps).toBe(30);
    expect(moved.workspacePath).toBe("/data/elsewhere");
    const unchanged = agentRequestBody(values, saved, catalog);
    expect(unchanged.workspacePath).toBeUndefined();
    const larkOff = agentRequestBody({ ...values, enableLark: "off" }, saved, catalog);
    expect(larkOff.lark).toEqual({ enabled: false });
    const neverOn: AgentFormSource = { ...saved, lark: { enabled: false } };
    const offValues = { ...agentFormValuesOf(neverOn), enableLark: "off" as const };
    expect(agentRequestBody(offValues, neverOn, catalog).lark).toBeUndefined();
  });

  test("keeps MCP rows the catalog no longer lists and rows left switched off", () => {
    const values = agentFormValuesOf(saved);
    const body = agentRequestBody(values, saved, catalog);
    expect(body.mcpServers).toEqual([
      { serverId: "mcp-1", enabled: true },
      { serverId: "mcp-2", enabled: false },
      { serverId: "gone", enabled: true },
    ]);
  });

  test("a cleared description or capability list is sent cleared, not left as it was", () => {
    const values = agentFormValuesOf(saved);
    const body = agentRequestBody({ ...values, description: "", skills: [] }, saved, catalog);
    expect(body.description).toBe("");
    expect(body.skills).toEqual([]);
  });
});
