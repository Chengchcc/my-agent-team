import { AnthropicChatModel } from "@my-agent-team/adapter-anthropic";
import { type AgentSpec, AgentSpecV1 } from "@my-agent-team/agent-spec";
import type { AgentEvent } from "@my-agent-team/framework";
import { createGenericAgent } from "@my-agent-team/harness";
import { loadConfig } from "./config.js";
import { sqliteAgentAdapter } from "./features/agent/adapter-sqlite.js";
import { agentRoutes, createAgentService } from "./features/agent/index.js";
import { sqliteCheckpointReadAdapter } from "./features/checkpoint/adapter-sqlite.js";
import { checkpointRoutes, createCheckpointService } from "./features/checkpoint/index.js";
import { createRunService, runRoutes } from "./features/run/index.js";
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

// Run feature — in-proc runner
const runSvc = createRunService({
  port: {
    create(input) {
      const status = input.status as "running";
      db.run("INSERT INTO runs (id, thread_id, input, status, started_at) VALUES (?, ?, ?, ?, ?)", [
        input.id,
        input.threadId,
        input.input,
        status,
        input.startedAt,
      ]);
      return { ...input, errorMessage: null, endedAt: null, status };
    },
    findById(id) {
      const row = db.query("SELECT * FROM runs WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row) return null;
      const rawStatus = row.status as string;
      return {
        id: row.id as string,
        threadId: row.thread_id as string,
        input: row.input as string,
        status: (rawStatus === "running" ||
        rawStatus === "completed" ||
        rawStatus === "aborted" ||
        rawStatus === "error"
          ? rawStatus
          : "error") as "running" | "completed" | "aborted" | "error",
        errorMessage: (row.error_message ?? null) as string | null,
        startedAt: row.started_at as number,
        endedAt: (row.ended_at ?? null) as number | null,
      };
    },
    updateStatus(id, status, errorMessage, endedAt) {
      db.run("UPDATE runs SET status = ?, error_message = ?, ended_at = ? WHERE id = ?", [
        status,
        errorMessage ?? null,
        endedAt ?? Date.now(),
        id,
      ]);
      return null;
    },
  },
  idGen: ulid,
  runner: async function* (spec, signal): AsyncIterable<AgentEvent> {
    const s = spec as AgentSpec;
    const model = new AnthropicChatModel({
      apiKey: config.anthropicApiKey,
      model: s.model.model,
      baseUrl: s.model.baseURL,
    });
    const agent = await createGenericAgent({
      workspace: s.workspace,
      model,
      threadId: s.threadId,
      permissionMode: s.permissionMode,
      checkpointerDb: db,
    });
    for await (const ev of agent.run(s.input, { signal, maxSteps: s.maxSteps })) {
      yield ev;
    }
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
