import { loadConfig } from "./config.js";
import { openDb } from "./infra/sqlite/db.js";
import { sqliteAgentAdapter } from "./features/agent/adapter-sqlite.js";
import { createAgentService, agentRoutes } from "./features/agent/index.js";
import { sqliteThreadAdapter } from "./features/thread/adapter-sqlite.js";
import { createThreadService, threadRoutes } from "./features/thread/index.js";
import { createRunService, runRoutes } from "./features/run/index.js";
import { sqliteCheckpointReadAdapter } from "./features/checkpoint/adapter-sqlite.js";
import { createCheckpointService, checkpointRoutes } from "./features/checkpoint/index.js";
import { createServer } from "./server.js";
import { createRouter } from "./http/router.js";
import { ulid } from "./infra/ids.js";
import { materializeWorkspace } from "./infra/workspace.js";
import { type AgentEvent } from "@my-agent-team/framework";
import { runEntry } from "@my-agent-team/runner-stdio";
import { AgentSpecV1, type AgentSpec } from "@my-agent-team/agent-spec";

const config = loadConfig();
const db = openDb(`${config.dataDir}/backend.db`);

// Infrastructure
const threads = new Set<string>();
const abortMap = new Map<string, AbortController>();

// Agent feature
const agentPort = sqliteAgentAdapter(db);
const agentSvc = createAgentService({
  port: agentPort,
  idGen: ulid,
  workspaceRoot: config.workspaceRoot,
  materializeWorkspace: (agentId, template) =>
    materializeWorkspace({
      workspaceRoot: config.workspaceRoot,
      agentId,
      template,
      templateDir: config.templateDir,
    }),
});

// Thread feature
const threadPort = sqliteThreadAdapter(db);
const threadSvc = createThreadService({
  port: threadPort,
  idGen: ulid,
  agentExists: async (id) => {
    try { await agentSvc.getById(id); return true; } catch { return false; }
  },
  cleanupCheckpoint: async (threadId) => {
    db.run("DELETE FROM checkpoint_messages WHERE thread_id = ?", [threadId]);
    db.run("DELETE FROM checkpoint_interrupts WHERE thread_id = ?", [threadId]);
    db.run("DELETE FROM checkpoint_events WHERE thread_id = ?", [threadId]);
  },
});

// Run feature — in-proc runner
const runSvc = createRunService({
  port: {
    create(input) {
      db.run(
        "INSERT INTO runs (id, thread_id, input, status, started_at) VALUES (?, ?, ?, ?, ?)",
        [input.id, input.threadId, input.input, input.status, input.startedAt],
      );
      return { ...input, errorMessage: null, endedAt: null };
    },
    findById(id) {
      const row = db.query("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return row ? {
        id: row.id as string, threadId: row.thread_id as string,
        input: row.input as string, status: row.status as "running" | "completed" | "aborted" | "error",
        errorMessage: (row.error_message ?? null) as string | null,
        startedAt: row.started_at as number, endedAt: (row.ended_at ?? null) as number | null,
      } : null;
    },
    updateStatus(id, status, errorMessage, endedAt) {
      db.run(
        "UPDATE runs SET status = ?, error_message = ?, ended_at = ? WHERE id = ?",
        [status, errorMessage ?? null, endedAt ?? Date.now(), id],
      );
      return null;
    },
  },
  idGen: ulid,
  runner: (spec, signal) => {
    return runEntry({
      specJson: JSON.stringify(spec),
      writeEvent: () => {},
      writeStderr: () => {},
      signal,
      checkpointerDb: db,
    }) as unknown as AsyncIterable<AgentEvent>;
    // Note: runEntry returns Promise<number>, but in-proc mode wraps differently.
    // For MVP we use a simplified runner that calls the harness directly.
  },
  threads,
  abortMap,
  threadSvc,
});

// Build spec helper
async function buildSpec(threadId: string, input: string): Promise<AgentSpec> {
  const thread = await threadSvc.getById(threadId);
  const agent = await agentSvc.getById(thread.agentId);
  const spec = AgentSpecV1.parse({
    schemaVersion: "1",
    workspace: agent.workspacePath,
    threadId,
    model: {
      provider: agent.modelProvider,
      model: agent.modelName,
      ...(agent.modelBaseUrl ? { baseURL: agent.modelBaseUrl } : {}),
    },
    apiKey: config.anthropicApiKey,
    permissionMode: agent.permissionMode,
    maxSteps: agent.maxSteps ?? undefined,
    input,
  });
  return spec;
}

// Checkpoint feature
const checkpointPort = sqliteCheckpointReadAdapter(db);
const checkpointSvc = createCheckpointService({ port: checkpointPort });

// HTTP router
const router = createRouter(config.authToken, {
  agents: agentRoutes(agentSvc),
  threads: threadRoutes(threadSvc),
  runs: runRoutes(runSvc, buildSpec),
  checkpoints: checkpointRoutes(checkpointSvc),
});

// Server
const server = createServer(config, router);
server.start();

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[backend] SIGTERM received, shutting down...");
  server.stop();
  db.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  server.stop();
  db.close();
  process.exit(0);
});
