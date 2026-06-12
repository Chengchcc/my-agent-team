import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { inMemoryEventLog } from "@my-agent-team/event-log";
import { loadConfig } from "../../src/config.js";
import { sqliteAgentAdapter } from "../../src/features/agent/adapter-sqlite.js";
import { createAgentService } from "../../src/features/agent/index.js";

const TEST_DIR = `/tmp/test-m11-e2e-${Date.now()}`;
const DATA_DIR = `${TEST_DIR}/data`;
const WS_ROOT = `${TEST_DIR}/workspaces`;
const TEMPLATE_DIR = `${TEST_DIR}/templates`;

beforeAll(async () => {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(WS_ROOT, { recursive: true });
  await mkdir(TEMPLATE_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("M11 Genesis e2e", () => {
  test("empty workspace creation includes BOOTSTRAP.md", async () => {
    // Create agent via service with real workspace materialization
    const { openDb } = await import("../../src/infra/sqlite/db.js");
    const db = openDb(`${DATA_DIR}/backend-genesis.db`);
    const port = sqliteAgentAdapter(db);
    const { materializeWorkspace } = await import("../../src/infra/workspace.js");

    const svc = createAgentService({
      port,
      idGen: () => `agent-gen-${Date.now()}`,
      workspaceRoot: WS_ROOT,
      materializeWorkspace: (agentId, template) =>
        materializeWorkspace({
          workspaceRoot: WS_ROOT,
          agentId,
          template,
          templateDir: TEMPLATE_DIR,
        }),
      purgeWorkspace: async () => {},
      purgeEventsForThreads: () => {},
      listThreadIds: async () => [],
      assertNoActiveRun: () => {},
    });

    const agent = await svc.create({
      name: "test-genesis",
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });

    // Verify BOOTSTRAP.md exists in workspace (empty workspace → genesis)
    const bootPath = path.join(agent.workspacePath, "BOOTSTRAP.md");
    expect(existsSync(bootPath)).toBe(true);
    const bootContent = await readFile(bootPath, "utf-8");
    expect(bootContent).toInclude("You just woke up");
    expect(bootContent).toInclude("SOUL.md");
    expect(bootContent).toInclude("BOOTSTRAP.md");

    // Verify memory/ dir exists
    expect(existsSync(path.join(agent.workspacePath, "memory"))).toBe(true);

    db.close();
  });
});

describe("M11 Growth e2e", () => {
  test("bootstrap() reads BOOTSTRAP.md directly when present", async () => {
    const { bootstrap } = await import("@my-agent-team/harness");
    const { consoleLogger } = await import("@my-agent-team/framework");
    const { LocalBackend, WorkspaceFS } = await import("@my-agent-team/workspace-fs");

    const ws = `${TEST_DIR}/ws-growth`;
    await mkdir(ws, { recursive: true });

    const be = new LocalBackend(ws);
    const fs = new WorkspaceFS({
      mounts: [
        { prefix: "/shared/", domain: "shared", backend: be },
        { prefix: "/private/", domain: "private", backend: be, posixRoot: ws },
      ],
    });

    // Write BOOTSTRAP.md → genesis mode
    await writeFile(path.join(ws, "BOOTSTRAP.md"), "GENESIS MODE PROMPT");

    const prompt = await bootstrap(fs, consoleLogger({ level: "silent" }));
    expect(prompt).toBe("GENESIS MODE PROMPT");

    // Delete BOOTSTRAP.md + write SOUL.md → normal mode
    await rm(path.join(ws, "BOOTSTRAP.md"));
    await writeFile(path.join(ws, "SOUL.md"), "I am a helpful assistant");

    const prompt2 = await bootstrap(fs, consoleLogger({ level: "silent" }));
    expect(prompt2).toInclude("I am a helpful assistant");
    expect(prompt2).toInclude("<soul>");
  });

  test("BOOTSTRAP_TEMPLATE exported from harness is non-empty", async () => {
    const { BOOTSTRAP_TEMPLATE, reflectionGuidance } = await import("@my-agent-team/harness");

    expect(BOOTSTRAP_TEMPLATE.length).toBeGreaterThan(100);
    expect(BOOTSTRAP_TEMPLATE).toInclude("SOUL.md");

    const guidance = reflectionGuidance();
    expect(guidance.length).toBeGreaterThan(50);
    expect(guidance).toInclude("memory");
    expect(guidance).toInclude("write tool");
  });
});

describe("M11 Liveness e2e", () => {
  test("reaper detects stale heartbeat and marks run interrupted", async () => {
    const eventLog = inMemoryEventLog();

    // Import RunSupervisor — it creates its own DB at config.dataDir/events.db
    const { RunSupervisor } = await import("../../src/features/run/supervisor.js");

    const sup = new RunSupervisor({
      eventLog,
      config: {
        ...loadConfig({
          ...process.env,
          BACKEND_DATA_DIR: DATA_DIR,
          BACKEND_AUTH_TOKEN: "test-token",
          ANTHROPIC_API_KEY: "sk-test",
        }),
        heartbeatTimeoutMs: 60_000, // 1 min → our 2min-old heartbeat is stale
        heartbeatIntervalMs: 5_000,
        reaperIntervalMs: 10_000,
        stepStallTimeoutMs: 300_000,
      },
      registry: { transportFor: async () => ({ send() {}, onMessage() {}, onClose() {}, close() {} }) } as never,
    });

    // Insert a run with old heartbeat into the supervisor's DB
    const db = sup.getDb();
    const oldHb = Date.now() - 120_000; // 2 min old
    db.run("INSERT INTO run (run_id, thread_id, status, started_at) VALUES (?, ?, 'running', ?)", [
      "run-liveness-e2e",
      "thread-liveness-e2e",
      oldHb,
    ]);
    db.run(
      "INSERT INTO attempt (attempt_id, run_id, pid, heartbeat_at, started_at) VALUES (?, ?, ?, ?, ?)",
      ["att-liveness-e2e", "run-liveness-e2e", 12345, oldHb, oldHb],
    );

    // Manually trigger rediscover (which uses reap logic)
    await sup.rediscover(eventLog);

    // Check run was marked interrupted
    const runRow = db.query("SELECT status FROM run WHERE run_id = ?").get("run-liveness-e2e") as
      | { status: string }
      | undefined;
    expect(runRow?.status).toBe("interrupted");

    sup.dispose();
  });
});
