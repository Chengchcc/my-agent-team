import { AgentSpecV1 } from "@my-agent-team/agent-spec";
import { sqliteEventLog } from "@my-agent-team/event-log";
import { loadConfig } from "./config.js";
import { sqliteAgentAdapter } from "./features/agent/adapter-sqlite.js";
import { agentRoutes, createAgentService } from "./features/agent/index.js";
import { sqliteCheckpointReadAdapter } from "./features/checkpoint/adapter-sqlite.js";
import { checkpointRoutes, createCheckpointService } from "./features/checkpoint/index.js";
import { createRunService, runRoutes } from "./features/run/index.js";
import { RunSupervisor } from "./features/run/supervisor.js";
import { sqliteThreadAdapter } from "./features/thread/adapter-sqlite.js";
import { createThreadService, threadRoutes } from "./features/thread/index.js";
import { createRouter } from "./http/router.js";
import { ulid } from "./infra/ids.js";
import { openDb } from "./infra/sqlite/db.js";
import { materializeWorkspace } from "./infra/workspace.js";
import { createServer } from "./server.js";

const config = loadConfig();
const db = openDb(`${config.dataDir}/backend.db`);

// Infrastructure
const threads = new Set<string>();

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
    try {
      await agentSvc.getById(id);
      return true;
    } catch {
      return false;
    }
  },
  cleanupCheckpoint: async (threadId) => {
    db.run("DELETE FROM checkpoint_messages WHERE thread_id = ?", [threadId]);
    db.run("DELETE FROM checkpoint_interrupts WHERE thread_id = ?", [threadId]);
    db.run("DELETE FROM checkpoint_events WHERE thread_id = ?", [threadId]);
  },
});

// M9: EventLog + Supervisor
const eventLog = sqliteEventLog({ db: `${config.dataDir}/events.db` });
const supervisor = new RunSupervisor({
  eventLog,
  config,
  runnerBin: `${import.meta.dir}/../../packages/runner-stdio/src/bin.ts`,
});

// Run feature — M9 subprocess model
const runSvc = createRunService({
  supervisor,
  eventLog,
  maxConcurrentRuns: config.maxConcurrentRuns,
  threads,
  idGen: ulid,
});

// Build spec helper — returns JSON string for subprocess env
async function buildSpecJson(
  threadId: string,
  input: string,
  overrides?: { runId?: string; mode?: "run" | "resume"; resumeCommand?: { approved: boolean; message?: string } },
): Promise<string> {
  const thread = await threadSvc.getById(threadId);
  const agent = await agentSvc.getById(thread.agentId);

  // Fix F: Use Zod parse for runtime validation (catches DB corruption / bad data)
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
    permissionMode: agent.permissionMode ?? "ask",
    maxSteps: agent.maxSteps ?? undefined,
    input,
    ...overrides,
  });
  return JSON.stringify(spec);
}

// Checkpoint feature
const checkpointPort = sqliteCheckpointReadAdapter(db);
const checkpointSvc = createCheckpointService({ port: checkpointPort });

// HTTP router
const router = createRouter(config.authToken, {
  agents: agentRoutes(agentSvc),
  threads: threadRoutes(threadSvc),
  runs: runRoutes(runSvc, buildSpecJson, async (runId: string) => {
    // Look up threadId for a given runId (needed for resume)
    const row = db.query("SELECT thread_id FROM run WHERE run_id = ?").get(runId) as { thread_id: string } | undefined;
    if (!row) throw new Error(`Run not found: ${runId}`);
    return row.thread_id;
  }),
  checkpoints: checkpointRoutes(checkpointSvc),
});

// Server
const server = createServer(config, router);

// M9: Re-discover live runs on startup
await supervisor.rediscover(eventLog);

server.start();
console.log(`[backend] listening on ${config.host}:${config.port}`);

// Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`[backend] ${signal} received, shutting down...`);
  server.stop();

  // Fix G: terminate all active subprocesses
  for (const runId of threads) {
    supervisor.cancel(runId);
  }
  // Give subprocesses time to exit gracefully
  await new Promise((r) => setTimeout(r, config.cancelGraceMs));

  supervisor.dispose();
  db.close();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
