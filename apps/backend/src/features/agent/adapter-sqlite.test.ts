import { describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteAgentAdapter } from "./adapter-sqlite.js";
import { agentConfigSchema, buildAgentConfig, serializeAgentYaml } from "./agent-config.js";
import { agentModelRef } from "./domain.js";

const db = openDb(":memory:");
const adapter = sqliteAgentAdapter(db);
function cfg(id: string, name: string, extra?: Partial<Parameters<typeof buildAgentConfig>[0]>) {
  return buildAgentConfig({
    id,
    name,
    model: { provider: "anthropic", model: "claude" },
    ...extra,
  });
}

describe("sqliteAgentAdapter", () => {
  test("create and findById roundtrip", async () => {
    const agent = await adapter.create({
      id: "a1",
      workspacePath: "/ws/a1",
      config: cfg("a1", "test"),
      now: 1000,
    });
    expect(agent.id).toBe("a1");
    expect(agent.config.name).toBe("test");
    expect(agent.config.runtime_config.permission_mode).toBe("ask");

    const found = await adapter.findById("a1");
    expect(found).not.toBeNull();
    expect(found?.workspacePath).toBe("/ws/a1");
  });

  test("findById returns null for unknown id", async () => {
    expect(await adapter.findById("nonexistent")).toBeNull();
  });

  test("list returns created agents", async () => {
    // Create 2 agents so we can assert on multiplicity independently
    await adapter.create({
      id: "b1",
      workspacePath: "/ws/b1",
      config: cfg("b1", "b1"),
      now: 2000,
    });
    await adapter.create({
      id: "b2",
      workspacePath: "/ws/b2",
      config: cfg("b2", "b2"),
      now: 2100,
    });
    const list = await adapter.list();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.some((a) => a.id === "b1")).toBe(true);
    expect(list.some((a) => a.id === "b2")).toBe(true);
  });

  test("list excludes archived by default", async () => {
    await adapter.archive("b1", 3000);
    const list = await adapter.list();
    expect(list.some((a) => a.id === "b1")).toBe(false);
  });

  test("update modifies config", async () => {
    const updated = await adapter.update("a1", { config: cfg("a1", "renamed"), now: 4000 });
    expect(updated).not.toBeNull();
    expect(updated?.config.name).toBe("renamed");
  });

  test("update persists lark profile_ref", async () => {
    const updated = await adapter.update("a1", {
      config: cfg("a1", "test", { lark: { enabled: true } }),
      now: 5000,
    });
    expect(updated).not.toBeNull();
    expect(updated?.config.lark.profile_ref).toBe("agent:a1");
  });
});

describe("agent config projects field (ADR 0023)", () => {
  test("round-trips through the serialized agent.yml form", () => {
    const config = cfg("a-projects", "ProjAgent", { projects: ["p1", "p2"] });
    expect(config.runtime_config.projects).toEqual(["p1", "p2"]);
    const yaml = serializeAgentYaml(config);
    expect(yaml).toContain("  projects:");
    expect(yaml).toContain('- "p1"');
  });

  test("prev fallback keeps existing projects when patch omits them", () => {
    const prev = cfg("a-prev", "Prev", { projects: ["p1"] });
    const next = buildAgentConfig({ id: "a-prev", name: "Prev", prev });
    expect(next.runtime_config.projects).toEqual(["p1"]);
  });
});

describe("agent config allowed_senders (H7)", () => {
  test("round-trips through the serialized agent.yml form and prev fallback", () => {
    const config = cfg("a-h7", "H7", {
      lark: { enabled: true, allowedSenders: ["ou_1", "ou_2"] },
    });
    expect(config.lark.allowed_senders).toEqual(["ou_1", "ou_2"]);
    expect(serializeAgentYaml(config)).toContain('- "ou_1"');
    const next = buildAgentConfig({ id: "a-h7", name: "H7", prev: config });
    expect(next.lark.allowed_senders).toEqual(["ou_1", "ou_2"]);
  });

  test("a new agent gets the explicit wildcard, not an empty list", () => {
    // The list used to be empty and mean "allow all", which the UI never said
    // out loud and which made "nobody" and "everybody" identical. A new agent
    // now stores the wildcard explicitly; an empty list means deny.
    const config = cfg("a-h7b", "H7b");
    expect(config.lark.allowed_senders).toEqual(["*"]);
    expect(config.lark.group_policy).toBeUndefined();
    expect(config.lark.require_mention).toBe(true);
    expect(config.lark.respond_to_mention_all).toBe(false);
    expect(config.lark.policy_rev).toBe(2);
    // Group policy defaults are written by the yaml, not implied.
    expect(serializeAgentYaml(config)).toContain('group_policy: "disabled"');
  });

  test("rev-1 configs keep answering: empty meant everyone, and is migrated", () => {
    // A stored config written before the semantics flip carries policy_rev 1
    // (or none). Its empty allowlist meant "no restriction", so the parse has
    // to carry that intent forward as the wildcard — otherwise upgrading
    // would silently lock the operator out of their own bot.
    const legacy = {
      ...cfg("a-h7c", "H7c"),
      lark: { ...cfg("a-h7c", "H7c").lark, allowed_senders: [], policy_rev: 1 },
    };
    const parsed = agentConfigSchema.parse(JSON.parse(JSON.stringify(legacy)));
    expect(parsed.lark.allowed_senders).toEqual(["*"]);
    expect(parsed.lark.policy_rev).toBe(2);
  });

  test("group policy round-trips through the yaml and the input shape", () => {
    const config = buildAgentConfig({
      id: "a-groups",
      name: "Groups",
      lark: {
        enabled: true,
        allowedSenders: ["ou_owner"],
        groupPolicy: "allowlist",
        groups: { oc_team: { policy: "open" }, oc_noisy: { policy: "disabled" } },
        requireMention: false,
        respondToMentionAll: true,
      },
    });
    expect(config.lark.group_policy).toBe("allowlist");
    expect(config.lark.groups).toEqual({
      oc_team: { policy: "open", allowed_senders: undefined },
      oc_noisy: { policy: "disabled", allowed_senders: undefined },
    });
    expect(config.lark.require_mention).toBe(false);
    expect(config.lark.respond_to_mention_all).toBe(true);
    const yaml = serializeAgentYaml(config);
    expect(yaml).toContain('group_policy: "allowlist"');
    expect(yaml).toContain("oc_team");
    expect(yaml).toContain('policy: "disabled"');
    // and the update path keeps them when the field is not sent
    const next = buildAgentConfig({ id: "a-groups", name: "Groups", prev: config });
    expect(next.lark.group_policy).toBe("allowlist");
    expect(next.lark.require_mention).toBe(false);
  });
});

describe("agentModelRef normalizes the stored reasoning effort", () => {
  const row = (reasoning_effort: string) =>
    ({
      config: {
        runtime_config: {
          runtime: "oma",
          model_id: "fake/echo",
          reasoning_effort,
        },
      },
    }) as unknown as Parameters<typeof agentModelRef>[0];

  test("valid rungs pass through, junk degrades to provider default", () => {
    expect(agentModelRef(row("high")).reasoningEffort).toBe("high");
    expect(agentModelRef(row("")).reasoningEffort).toBeUndefined();
    // A row from before the enum (or a hand-edited agent.yml) must not fail
    // the child's whole execute payload at the wire schema.
    expect(agentModelRef(row("medium")).reasoningEffort).toBeUndefined();
    expect(agentModelRef(row("XHIGH")).reasoningEffort).toBeUndefined();
  });
});
