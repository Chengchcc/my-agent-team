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
    harness: "oma",
    model: "anthropic/claude",
    ...extra,
  });
}

describe("sqliteAgentAdapter", () => {
  test("list() survives a row stored before the harness rename", async () => {
    // The reported boot crash: parseRow throws on the first row whose config
    // predates 18fa47fb, and installFeatures' name map (`list(true)`) is the
    // first thing to read agents — so the backend never started.
    const current = cfg("a-legacy-row", "Legacy row");
    const { harness: _h, model: _m, ...restRuntime } = current.runtime_config;
    const legacy = {
      ...current,
      runtime_config: { ...restRuntime, runtime: "oma", model_id: "zai/glm-4.6" },
    };
    db.run(
      "INSERT INTO agents (id, workspace_path, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["a-legacy-row", "/ws/legacy", JSON.stringify(legacy), 1, 1],
    );
    const listed = await adapter.list(true);
    const row = listed.find((r) => r.id === "a-legacy-row");
    expect(row?.config.runtime_config.harness).toBe("oma");
    expect(row?.config.runtime_config.model).toBe("zai/glm-4.6");
  });

  test("hardDelete works without touching tables the schema dropped", async () => {
    // It used to SELECT COUNT(*) FROM member/thread - tables the schema no
    // longer has - so every hard delete answered 500 ("no such table: member").
    await adapter.create({
      id: "hd1",
      workspacePath: "/ws/hd1",
      config: cfg("hd1", "gone"),
      now: 2000,
    });
    expect(await adapter.hardDelete("hd1")).toEqual({ deletedAgent: true });
    expect(await adapter.hardDelete("hd1")).toEqual({ deletedAgent: false });
  });

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

  test("a configured harness and model reach the ref, and unset stays unset", () => {
    const configured = cfg("a-harness", "Harness", {
      harness: "oma",
      model: "deepseek/deepseek-v4-pro",
    });
    expect(configured.runtime_config.harness).toBe("oma");
    expect(configured.runtime_config.model).toBe("deepseek/deepseek-v4-pro");
    expect(agentModelRef({ config: configured })).toEqual({
      backendKind: "acp",
      modelId: "acp/oma",
      harnessModel: "deepseek/deepseek-v4-pro",
    });

    // agent.yml is the portable source of truth: a field the serializer
    // forgets is a field a file-first agent silently loses.
    expect(serializeAgentYaml(configured)).toContain('model: "deepseek/deepseek-v4-pro"');

    // "" is the stored "nothing named": the ref must not carry a model nobody
    // chose, or the run would be pinned to whatever the agent last held.
    const plain = cfg("a-harness-plain", "Plain", { model: "" });
    expect(plain.runtime_config.model).toBe("");
    expect(agentModelRef({ config: plain })).toEqual({
      backendKind: "acp",
      modelId: "acp/oma",
    });
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

  test("a config with NO policy_rev key is the real legacy shape, and migrates", () => {
    // The first version of this test set `policy_rev: 1` explicitly and went
    // green while the migration was broken: real stored configs have no such
    // key at all, and the schema defaulted the missing key to 2, so the
    // transform never ran. That would have read every existing empty
    // allowlist as "deny everyone" and locked the operator out on upgrade.
    const current = cfg("a-h7c0", "H7c0");
    const lark: Record<string, unknown> = { ...current.lark, allowed_senders: [] };
    delete lark.policy_rev;
    const parsed = agentConfigSchema.parse(JSON.parse(JSON.stringify({ ...current, lark })));
    expect(parsed.lark.policy_rev).toBe(2);
    expect(parsed.lark.allowed_senders).toEqual(["*"]);
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

  test("a pre-rename config (runtime/model_id) upgrades instead of bricking boot", () => {
    // 18fa47fb renamed the axes with no data migration, and the first thing
    // boot does is list agents for its name map — so ONE row written before it
    // took the whole backend down with a ZodError on runtime_config.harness.
    const current = cfg("a-legacy", "Legacy");
    const { harness: _h, model: _m, ...restRuntime } = current.runtime_config;
    const legacy = {
      ...current,
      runtime_config: { ...restRuntime, runtime: "oma", model_id: "zai/glm-4.6" },
    };
    const parsed = agentConfigSchema.parse(JSON.parse(JSON.stringify(legacy)));
    expect(parsed.runtime_config.harness).toBe("oma");
    expect(parsed.runtime_config.model).toBe("zai/glm-4.6");
  });

  test("the old backend-kind spelling and the old model placeholder both map", () => {
    const current = cfg("a-legacy2", "Legacy2");
    const { harness: _h, model: _m, ...restRuntime } = current.runtime_config;
    // claude_code was the BackendKind; the ACP registry key is `claude`.
    const parsed = agentConfigSchema.parse(
      JSON.parse(
        JSON.stringify({
          ...current,
          runtime_config: {
            ...restRuntime,
            runtime: "claude_code",
            model_id: "unconfigured/none",
            harness_model: "claude-sonnet-4-6",
          },
        }),
      ),
    );
    expect(parsed.runtime_config.harness).toBe("claude");
    // The placeholder meant "nothing chosen"; the ACP model is the real one.
    expect(parsed.runtime_config.model).toBe("claude-sonnet-4-6");
  });

  test("the harness-side model wins when a legacy row set both", () => {
    // The old form had two pickers: `model` (product-side provider/model, stored
    // as model_id) and `harnessModel` (what the harness actually ran). Today's
    // single `model` is the second one — agentModelRef hands it to the child as
    // `harnessModel` — so a row with both must resolve to the harness's value.
    const current = cfg("a-legacy-both", "Legacy both");
    const { harness: _h, model: _m, ...restRuntime } = current.runtime_config;
    const parsed = agentConfigSchema.parse(
      JSON.parse(
        JSON.stringify({
          ...current,
          runtime_config: {
            ...restRuntime,
            runtime: "claude_code",
            model_id: "anthropic/claude-sonnet-4-6",
            harness_model: "claude-sonnet-4-6",
          },
        }),
      ),
    );
    expect(parsed.runtime_config.harness).toBe("claude");
    expect(parsed.runtime_config.model).toBe("claude-sonnet-4-6");
  });

  test("a config with neither shape still fails loudly", () => {
    const current = cfg("a-legacy3", "Legacy3");
    const { harness: _h, model: _m, ...restRuntime } = current.runtime_config;
    expect(() =>
      agentConfigSchema.parse(
        JSON.parse(JSON.stringify({ ...current, runtime_config: restRuntime })),
      ),
    ).toThrow();
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

describe("ambient rules round-trip (ADR 0046)", () => {
  test("build → yaml → parse keeps the rules; absent lark block defaults empty", () => {
    const config = buildAgentConfig({
      id: "a-amb",
      name: "Amb",
      harness: "oma",
      lark: {
        enabled: true,
        ambientRules: [
          {
            id: "deploy-alarm",
            chats: ["oc_dev"],
            senders: ["ou_alice"],
            keyword: "deploy",
            mode: "act",
            instruction: "去查部署问题",
          },
          { id: "watch-only", keyword: "Alert", mode: "record" },
        ],
      },
    });
    expect(config.lark.ambient.rules).toHaveLength(2);
    expect(config.lark.ambient.rules[0]).toMatchObject({
      chats: ["oc_dev"],
      senders: ["ou_alice"],
      mode: "act",
    });

    // agent.yml is the single source: the serializer dropping the section
    // would silently delete the operator's rules on the next write.
    const yaml = serializeAgentYaml(config);
    expect(yaml).toContain("ambient:");
    expect(yaml).toContain('id: "deploy-alarm"');
    expect(yaml).toContain("oc_dev");
    expect(yaml).toContain("去查部署问题");
    const reparsed = agentConfigSchema.parse(JSON.parse(JSON.stringify(config)));
    expect(reparsed.lark.ambient.rules).toHaveLength(2);

    // An update that does not mention rules keeps the previous list.
    const updated = buildAgentConfig({ id: "a-amb", name: "Amb", prev: config });
    expect(updated.lark.ambient.rules).toHaveLength(2);
  });

  test("an act rule without an instruction is rejected at config time", () => {
    // Firing a run that doesn't know its job is the failure this prevents:
    // the agent gets a promotion framing with no instruction to follow.
    expect(() =>
      agentConfigSchema.parse({
        ...cfg("a-bad", "Bad"),
        lark: {
          ...cfg("a-bad", "Bad").lark,
          ambient: {
            rules: [{ id: "r1", keyword: "x", mode: "act", instruction: "" }],
          },
        },
      }),
    ).toThrow();
  });
});

describe("capability cards round-trip (ADR 0048)", () => {
  test("skills serialize into agent.yml and parse back; updates keep them", () => {
    const config = buildAgentConfig({
      id: "a-card",
      name: "Card",
      harness: "oma",
      description: "前端问题都给我",
      skills: [{ id: "react", description: "组件与样式" }, { id: "a11y" }],
    });
    expect(config.skills).toHaveLength(2);
    // A missing description fills "" on parse (the card reads the same).
    expect(config.skills[1]).toMatchObject({ id: "a11y", description: "" });

    const yaml = serializeAgentYaml(config);
    expect(yaml).toContain("skills:");
    expect(yaml).toContain('id: "react"');
    expect(yaml).toContain("组件与样式");

    const reparsed = agentConfigSchema.parse(JSON.parse(JSON.stringify(config)));
    expect(reparsed.skills).toHaveLength(2);

    // An update that does not mention skills keeps them.
    const updated = buildAgentConfig({ id: "a-card", name: "Card", prev: config });
    expect(updated.skills).toHaveLength(2);
    // A replace-semantics update swaps the whole list.
    const replaced = buildAgentConfig({
      id: "a-card",
      name: "Card",
      prev: config,
      skills: [{ id: "only" }],
    });
    expect(replaced.skills.map((s) => s.id)).toEqual(["only"]);
  });
});

describe("role round-trip (ADR 0049)", () => {
  test("role serializes, parses, and updates replace-semantics", () => {
    const config = buildAgentConfig({
      id: "a-role",
      name: "Role",
      harness: "oma",
      role: "worker",
    });
    expect(config.role).toBe("worker");
    expect(serializeAgentYaml(config)).toContain('role: "worker"');

    const reparsed = agentConfigSchema.parse(JSON.parse(JSON.stringify(config)));
    expect(reparsed.role).toBe("worker");

    // An update not mentioning role keeps it; an explicit one replaces it.
    const kept = buildAgentConfig({ id: "a-role", name: "Role", prev: config });
    expect(kept.role).toBe("worker");
    const cleared = buildAgentConfig({ id: "a-role", name: "Role", prev: config, role: "front" });
    expect(cleared.role).toBe("front");
    // Absent role parses as undefined (front-capable default).
    expect(buildAgentConfig({ id: "b", name: "B", harness: "oma" }).role).toBeUndefined();
  });
});
