import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

process.env.BACKEND_AUTH_TOKEN = "test-token";
process.env.ANTHROPIC_API_KEY = "sk-test";

const modelsYml = `providers:
  anthropic:
    api: anthropic-messages
    apiKey: ANTHROPIC_API_KEY
    models:
      - id: claude-sonnet-4-6
        name: claude-sonnet-4-6
        maxTokens: 8192
`;

function setup(dir: string) {
  const builtinDir = `${dir}/builtin-skills`;
  mkdirSync(dir, { recursive: true });
  mkdirSync(builtinDir, { recursive: true });
  writeFileSync(`${dir}/models.yml`, modelsYml);

  return {
    dataDir: dir,
    workspaceRoot: dir,
    templateDir: `${dir}/templates`,
    host: "0.0.0.0",
    port: 3000,
    authToken: "test-token",
    cancelGraceMs: 100,
    maxConcurrentRuns: 4,
    builtinSkillsDir: builtinDir,
  };
}

describe("InstalledFeatures", () => {
  test("installFeatures returns complete FeatureSet", async () => {
    const dir = mkdtempSync(`${tmpdir()}/p9-feat-`);
    const cfg = setup(dir);

    const { createBackendServices } = await import("./services.js");
    const services = createBackendServices(cfg as Parameters<typeof createBackendServices>[0]);

    const { installFeatures } = await import("./features.js");
    const installed = await installFeatures(services);

    expect(installed.featureSet).toBeDefined();
    expect(installed.featureSet.agents).toBeDefined();
    expect(installed.featureSet.conversations).toBeDefined();
    expect(installed.featureSet.ops).toBeDefined();
    expect(installed.featureSet.projects).toBeDefined();
    expect(installed.featureSet.skillPacks).toBeDefined();
    expect(installed.featureSet.agentRuns).toBeDefined();
    expect(installed.featureSet.settings).toBeDefined();
    expect(installed.featureSet.mcp).toBeDefined();
    expect(installed.featureSet.models).toBeDefined();
    expect(typeof installed.start).toBe("function");
    expect(typeof installed.dispose).toBe("function");

    await installed.dispose();
    await services.mcpClientManager.disconnectAll();
    services.db.close();
  });

  test("createApp mounts FeatureSet, /health 200, lifecycle works", async () => {
    const dir = mkdtempSync(`${tmpdir()}/p9-feat-`);
    const cfg = setup(dir);

    const { createBackendServices } = await import("./services.js");
    const services = createBackendServices(cfg as Parameters<typeof createBackendServices>[0]);

    const { installFeatures } = await import("./features.js");
    const installed = await installFeatures(services);

    const { createApp } = await import("../app.js");
    const app = createApp(cfg.authToken, installed.featureSet);
    expect(app).toBeDefined();

    const healthRes = await app.handle(new Request("http://localhost/health"));
    expect(healthRes.status).toBe(200);

    await installed.start();
    await installed.dispose();

    await services.mcpClientManager.disconnectAll();
    services.db.close();
  });
});

test("boot pull-up starts bots for lark-enabled agents", async () => {
  const dir = mkdtempSync(`${tmpdir()}/p9-lark-boot-`);
  const cfg = setup(dir);

  // The real registry spawns the actual bot bin, which cannot reach Lark
  // from a test; a recording fake pins the pull-up's contract instead.
  const ensured: Array<{ agentId: string; profile: string | null }> = [];
  const fakeRegistry = {
    async ensureLarkBot(agentId: string, _name?: string | null, larkProfile?: string | null) {
      ensured.push({ agentId, profile: larkProfile ?? null });
    },
    async stopLarkBot() {},
    statusOf(agentId: string) {
      return ensured.some((e) => e.agentId === agentId)
        ? ("running" as const)
        : ("configured" as const);
    },
    async dispose() {},
  };

  const { createBackendServices } = await import("./services.js");
  const services = createBackendServices(cfg as Parameters<typeof createBackendServices>[0], {
    larkBotRegistry: fakeRegistry,
  });

  const { installFeatures } = await import("./features.js");
  const installed = await installFeatures(services);

  const { createApp } = await import("../app.js");
  const app = createApp(cfg.authToken, installed.featureSet);
  const res = await app.handle(
    new Request("http://localhost/api/agents/default", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-auth-token": cfg.authToken },
      body: JSON.stringify({ lark: { enabled: true, appId: "cli_test", appSecret: "secret" } }),
    }),
  );
  expect(res.status).toBe(200);

  // An archived agent keeps its lark config; the pull-up used to list archived
  // rows too and started a bot for a deleted agent on every restart.
  const archivable = await app.handle(
    new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json", "x-auth-token": cfg.authToken },
      body: JSON.stringify({
        name: "ArchivedBotProbe",
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        lark: { enabled: true, appId: "cli_archived", appSecret: "secret" },
      }),
    }),
  );
  const archivableBody = (await archivable.json()) as { id?: string };
  expect(archivable.status).toBe(201);
  const archived = await app.handle(
    new Request(`http://localhost/api/agents/${archivableBody.id}`, {
      method: "DELETE",
      headers: { "x-auth-token": cfg.authToken },
    }),
  );
  expect(archived.status).toBe(200);

  await installed.start();
  // PATCH starts the bot immediately and the boot pull-up re-ensures it —
  // both callers, one contract: only enabled agents, derived profile.
  expect(ensured.length).toBeGreaterThanOrEqual(1);
  expect(ensured.every((e) => e.agentId === "default" && e.profile === "agent:default")).toBe(true);
  expect(services.larkBotRegistry.statusOf("default")).toBe("running");

  await installed.dispose();
  await services.mcpClientManager.disconnectAll();
  services.db.close();
});

test("fresh boot: default agent carries a real model + the onCreate chain ran", async () => {
  const dir = mkdtempSync(`${tmpdir()}/p9-fresh-`);
  // The oma child's runtime catalog resolves models.yml via
  // OMA_HOME (same env the real deployment sets).
  process.env.OMA_HOME = dir;
  const cfg = setup(dir);

  const { createBackendServices } = await import("./services.js");
  const services = createBackendServices(cfg as Parameters<typeof createBackendServices>[0]);

  const { installFeatures } = await import("./features.js");
  const installed = await installFeatures(services);
  await installed.start();

  const db = services.db;
  const agentRow = db.query("SELECT config FROM agents WHERE id = 'default'").get() as {
    config: string;
  } | null;
  expect(agentRow).not.toBeNull();
  const config = JSON.parse(agentRow!.config) as {
    runtime_config: { runtime: string; model_id: string };
  };
  // The seed derives from the live catalog, never the placeholder.
  expect(config.runtime_config.runtime).toBe("oma");
  expect(config.runtime_config.model_id).not.toBe("unconfigured/none");
  expect(config.runtime_config.model_id).toContain("/");

  // A2 chain: the builtin skill pack is assigned on create.
  const packRows = db
    .query(
      "SELECT ap.pack_id FROM agent_skill_pack ap JOIN skill_pack p ON p.id = ap.pack_id WHERE ap.agent_id = 'default'",
    )
    .all() as Array<{ pack_id: string }>;
  expect(packRows.map((r) => r.pack_id)).toContain("builtin");

  // The workspace reconcile materialized the skills links + the bridged
  // .mcp.json. The workflow server must be in the DEFAULT enabled set: it is
  // the only read path into <dataDir>/workflows for a run (the file tools are
  // sandboxed to the agent workspace), so dropping it silently kills the
  // workflow-editor chat and the agentic-workflow-dsl skill.
  const workspace = `${dir}/agents/default`;
  expect(existsSync(`${workspace}/.oma/skills`)).toBe(true);
  const mcp = JSON.parse(readFileSync(`${workspace}/.mcp.json`, "utf8")) as {
    mcpServers: Record<string, unknown>;
  };
  expect(Object.keys(mcp.mcpServers)).toContain("workflow");

  await installed.dispose();
  await services.mcpClientManager.disconnectAll();
  services.db.close();
});
