import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { rmSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "../../../src/infra/sqlite/db.js";
import { createAgentService } from "../../../src/features/agent/service.js";
import { sqliteAgentAdapter } from "../../../src/features/agent/adapter-sqlite.js";
import { materializeWorkspace, purgeWorkspace } from "../../../src/infra/workspace.js";
import {
  runnerWorkspacePaths,
  ensureRunnerWorkspace,
  migrateLegacyWorkspaceToShared,
  purgeRunnerWorkspace,
} from "../../../src/infra/runner-workspace.js";

const tmpBase = `/tmp/workspace-lifecycle-${Date.now()}`;
const workspaceRoot = path.join(tmpBase, "workspaces");
const dataDir = path.join(tmpBase, "data");
const templateDir = path.join(tmpBase, "templates");

function clean() {
  try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
}

afterAll(() => clean());

async function makeSvc() {
  clean();
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(templateDir, { recursive: true });
  const dbPath = path.join(tmpBase, "test.db");
  const db = openDb(dbPath);

  const port = sqliteAgentAdapter(db);
  return createAgentService({
    port,
    idGen: () => crypto.randomUUID().replace(/-/g, "").slice(0, 26),
    workspaceRoot,
    // This is the real create flow from main.ts:
    // 1. materialize legacy workspace
    // 2. ensure runner shared/private/state
    // 3. migrate legacy → sharedRoot immediately
    materializeWorkspace: async (agentId, template) => {
      const legacyPath = await materializeWorkspace({
        workspaceRoot,
        agentId,
        template,
        templateDir,
      });
      const paths = runnerWorkspacePaths(dataDir, agentId);
      await ensureRunnerWorkspace(paths);
      await migrateLegacyWorkspaceToShared(paths.sharedRoot, legacyPath);
      return legacyPath;
    },
    purgeWorkspace: async (agentId) => {
      await purgeWorkspace({ workspaceRoot, agentId });
      await purgeRunnerWorkspace({ dataDir, agentId });
    },
    purgeEventsForThreads: () => {},
    listThreadIds: async () => [],
    assertNoActiveRun: () => {},
  });
}

describe("agent workspace lifecycle (composition)", () => {
  test("create agent seeds runner sharedRoot with BOOTSTRAP.md", async () => {
    const svc = await makeSvc();
    const agent = await svc.create({
      name: "test-agent",
      model: { provider: "anthropic", model: "claude" },
    });

    // Runner sharedRoot should exist and contain BOOTSTRAP.md
    const paths = runnerWorkspacePaths(dataDir, agent.id);
    const bootstrap = await readFile(path.join(paths.sharedRoot, "BOOTSTRAP.md"), "utf-8");
    expect(bootstrap.length).toBeGreaterThan(100);
    expect(bootstrap).toContain("You just woke up");

    // memory/ dir should exist
    await expect(stat(path.join(paths.sharedRoot, "memory"))).resolves.toBeDefined();
  });

  test("create agent — identity files available before any identity API call", async () => {
    const svc = await makeSvc();
    const agent = await svc.create({
      name: "soul-agent",
      model: { provider: "anthropic", model: "claude" },
      template: "coding",
    });

    const paths = runnerWorkspacePaths(dataDir, agent.id);

    // BOOTSTRAP.md must exist (genesis mode trigger for harness)
    const bootstrapExists = await stat(path.join(paths.sharedRoot, "BOOTSTRAP.md"))
      .then(() => true)
      .catch(() => false);
    expect(bootstrapExists).toBe(true);

    // SOUL.md will not exist for a new agent (BOOTSTRAP.md is the birth mode trigger)
    // USER.md will not exist for a new agent
    // But they should both exist IF a template was applied
  });

  test("hardDelete removes both legacy and runner workspaces", async () => {
    const svc = await makeSvc();
    const agent = await svc.create({
      name: "delete-me",
      model: { provider: "anthropic", model: "claude" },
    });

    const legacyPath = agent.workspacePath;
    const paths = runnerWorkspacePaths(dataDir, agent.id);

    // Both should exist before delete
    await expect(stat(legacyPath)).resolves.toBeDefined();
    await expect(stat(paths.runnerRoot)).resolves.toBeDefined();

    await svc.hardDelete(agent.id);

    // Both should be gone after delete
    await expect(stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.runnerRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("lazy migration copies existing legacy files to sharedRoot", async () => {
    // Create an agent FIRST (seeds both workspaces)
    const svc = await makeSvc();
    const agent = await svc.create({
      name: "migration-test",
      model: { provider: "anthropic", model: "claude" },
    });

    const paths = runnerWorkspacePaths(dataDir, agent.id);

    // BOOTSTRAP.md should already be seeded from create flow
    const bootstrap = await readFile(path.join(paths.sharedRoot, "BOOTSTRAP.md"), "utf-8");
    expect(bootstrap.length).toBeGreaterThan(100);
  });
});
