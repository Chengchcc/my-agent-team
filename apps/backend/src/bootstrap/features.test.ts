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
  // A minimal builtin wiki root: the boot seeds `architecture`/`guides` from
  // here, and the onboarding agent attaches what that same boot installed.
  const docsDir = `${dir}/docs`;
  for (const zone of ["architecture", "guides"]) {
    mkdirSync(`${docsDir}/${zone}`, { recursive: true });
    writeFileSync(`${docsDir}/${zone}/README.md`, `# ${zone}\n`);
  }

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
    knowledgePacksDir: docsDir,
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
  // The real profile writer shells out to `lark-cli config init`, which edits
  // the operator's `~/.lark-cli/config.json` and drops secret files: running
  // this test used to rewrite the machine's LIVE Lark credentials (the bot then
  // crash-looped with `invalid param`). A fake keeps the seam covered.
  const profileInits: Array<{ profileRef: string; appId: string }> = [];
  const services = createBackendServices(cfg as Parameters<typeof createBackendServices>[0], {
    larkBotRegistry: fakeRegistry,
    larkProfileInit: async (profileRef, appId) => {
      profileInits.push({ profileRef, appId });
    },
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
  // The enable went through the injected writer, NOT the operator's config.
  expect(profileInits).toEqual([{ profileRef: "agent:default", appId: "cli_test" }]);

  // An archived agent keeps its lark config; the pull-up used to list archived
  // rows too and started a bot for a deleted agent on every restart.
  const archivable = await app.handle(
    new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json", "x-auth-token": cfg.authToken },
      body: JSON.stringify({
        name: "ArchivedBotProbe",
        harness: "oma",
        model: "anthropic/claude-sonnet-4-6",
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

  // Only the BOOT pull-up counts: creating the probe legitimately ensured its
  // bot once, and asserting over that would test the create path instead of
  // the pull-up's "enabled agents only" rule.
  const beforeBoot = ensured.length;
  await installed.start();
  const bootEnsures = ensured.slice(beforeBoot);
  expect(bootEnsures.length).toBeGreaterThanOrEqual(1);
  expect(bootEnsures.every((e) => e.agentId === "default" && e.profile === "agent:default")).toBe(
    true,
  );
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
    runtime_config: { harness: string; model: string };
  };
  // The seed derives from the live catalogue, never a placeholder.
  expect(config.runtime_config.harness).toBe("oma");
  expect(config.runtime_config.model).not.toBe("");
  expect(config.runtime_config.model).toContain("/");

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

  // ADR 0074 seed contract: exactly the personal agent and ONE team member.
  // A third seeded agent with role null would be a second front desk, which is
  // the mess that gets cleaned by hand on every install that seeds it.
  const seeded = db.query("SELECT id, config FROM agents ORDER BY id").all() as Array<{
    id: string;
    config: string;
  }>;
  expect(seeded.map((row) => row.id).sort()).toEqual(["coder", "default", "researcher"]);
  const personal = JSON.parse(seeded.find((row) => row.id === "default")!.config) as {
    name: string;
    role?: string;
  };
  expect(personal.name).toBe("Personal Agent");
  const coder = JSON.parse(seeded.find((row) => row.id === "coder")!.config) as {
    name: string;
    role?: string;
  };
  expect(coder.name).toBe("Coder");
  // The worker role is what keeps it OUT of the front desk; without it the
  // seed would create a second assistant.
  expect(coder.role).toBe("worker");
  // Both members carry a role-appropriate identity, written at seed time and
  // then owned by the operator (never rewritten by a later boot).
  const coderSoul = readFileSync(`${dir}/agents/coder/SOUL.md`, "utf8");
  expect(coderSoul).toContain("# Coder");
  const researcherSoul = readFileSync(`${dir}/agents/researcher/SOUL.md`, "utf8");
  expect(researcherSoul).toContain("# Researcher");
  const personalSoul = readFileSync(`${dir}/agents/default/SOUL.md`, "utf8");
  expect(personalSoul).toContain("# Personal Agent");
  // The marker is what keeps a deliberate deletion deleted on the next boot.
  const marker = JSON.parse(readFileSync(`${dir}/.agent-seed.json`, "utf8")) as {
    seeded: string[];
  };
  expect(marker.seeded.sort()).toEqual(["coder", "default", "researcher"]);
  // The nightly sweep exists from the first boot: knowledge decays unless
  // something runs lint on a schedule.
  const workflow = JSON.parse(readFileSync(`${dir}/workflows/wiki-lint.workflow.json`, "utf8")) as {
    triggers: Array<{ type: string; cron?: string }>;
    nodes: Array<{ type: string; agentId?: string }>;
  };
  expect(workflow.triggers[0]?.type).toBe("cron");
  expect(workflow.triggers[0]?.cron).toBe("0 4 * * *");
  expect(workflow.nodes.some((node) => node.type === "agent" && node.agentId === "default")).toBe(
    true,
  );

  await installed.dispose();
  await services.mcpClientManager.disconnectAll();
  services.db.close();
});

describe("front-desk routing discipline (ADR 0057)", () => {
  test("a front gets the discipline even with no identity files", async () => {
    const { buildAgentSystemPrompt } = await import("./features.js");
    const prompt = buildAgentSystemPrompt(null, null, { role: "front" });
    expect(prompt).toContain("## Routing (you are the front desk)");
    expect(prompt).toContain("`verb` is an argument to dispatch, not an exit");
  });

  test("a legacy agent with no role is a front", async () => {
    const { buildAgentSystemPrompt } = await import("./features.js");
    expect(buildAgentSystemPrompt(null, null) ?? "").toContain("front desk");
    expect(buildAgentSystemPrompt(null, null, { role: null }) ?? "").toContain("front desk");
  });

  test("a worker does not: it has nobody to route for", async () => {
    const { buildAgentSystemPrompt } = await import("./features.js");
    expect(buildAgentSystemPrompt("soul", null, { role: "worker" })).toBe("soul");
  });

  test("the identity stays first and the discipline follows it", async () => {
    const { buildAgentSystemPrompt } = await import("./features.js");
    const prompt = buildAgentSystemPrompt("SOUL TEXT", "USER TEXT", { role: "front" }) ?? "";
    expect(prompt.indexOf("SOUL TEXT")).toBeLessThan(prompt.indexOf("## Routing"));
    expect(prompt).toContain("User context:\nUSER TEXT");
  });

  test("the three golden deviations are each addressed in the text", async () => {
    const { buildAgentSystemPrompt } = await import("./features.js");
    const prompt = buildAgentSystemPrompt(null, null, { role: "front" }) ?? "";
    expect(prompt).toContain("not an exit"); // verb placed in "action"
    expect(prompt).toContain("neither is ANSWER"); // write/investigate answered
    expect(prompt).toContain("already states is NOT missing"); // re-asking known slots
  });
});
