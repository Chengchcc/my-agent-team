import { AgentSpecV1 } from "@my-agent-team/agent-spec";
import { sqliteEventLog } from "@my-agent-team/event-log";
import { loadConfig } from "./config.js";
import { sqliteAgentAdapter } from "./features/agent/adapter-sqlite.js";
import { AgentBusyError, agentRoutes, createAgentService } from "./features/agent/index.js";
import { sqliteCheckpointReadAdapter, sqliteCheckpointWriteAdapter } from "./features/checkpoint/adapter-sqlite.js";
import { checkpointRoutes, createCheckpointService } from "./features/checkpoint/index.js";
import { backfillLegacyThreads, conversationRoutes, createConversationService, sqliteConversationAdapter } from "./features/conversation/index.js";
import { createRunService, runRoutes } from "./features/run/index.js";
import { RunSupervisor } from "./features/run/supervisor.js";
import { sqliteThreadAdapter } from "./features/thread/adapter-sqlite.js";
import { createThreadService, threadRoutes } from "./features/thread/index.js";
import { createRouter } from "./http/router.js";
import { ulid } from "./infra/ids.js";
import { openDb } from "./infra/sqlite/db.js";
import { materializeWorkspace, purgeWorkspace } from "./infra/workspace.js";
import { createServer } from "./server.js";

const config = loadConfig();
const db = openDb(`${config.dataDir}/backend.db`);

// Infrastructure
const threads = new Set<string>();

// M9: EventLog + Supervisor (created before agentSvc to inject getDb() into hardDelete)
const eventLog = sqliteEventLog({ db: `${config.dataDir}/events.db` });
const supervisor = new RunSupervisor({
  eventLog,
  config,
  runnerBin: `${import.meta.dir}/../../../packages/runner-stdio/src/bin.ts`,
});

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

  // M11 hardDelete dependencies — all closures from composition root
  purgeWorkspace: (agentId) => purgeWorkspace({ workspaceRoot: config.workspaceRoot, agentId }),

  purgeEventsForThreads: (threadIds) => {
    const edb = supervisor.getDb();
    const tx = edb.transaction((ids: string[]) => {
      for (const tid of ids) {
        edb.run("DELETE FROM event_log WHERE thread_id = ?", [tid]);
        edb.run("DELETE FROM attempt WHERE run_id IN (SELECT run_id FROM run WHERE thread_id = ?)", [tid]);
        edb.run("DELETE FROM run WHERE thread_id = ?", [tid]);
      }
    });
    tx(threadIds);
  },

  listThreadIds: async (agentId) =>
    (db.query("SELECT id FROM threads WHERE agent_id = ?").all(agentId) as { id: string }[]).map((r) => r.id),

  assertNoActiveRun: (agentId) => {
    const edb = supervisor.getDb();
    const busy = edb.query(
      `SELECT 1 FROM attempt WHERE ended_at IS NULL
         AND run_id IN (SELECT run_id FROM run WHERE thread_id IN
           (SELECT id FROM threads WHERE agent_id = ?)) LIMIT 1`,
    ).get(agentId);
    if (busy) throw new AgentBusyError(agentId);
  },
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

// Checkpoint read adapter — needed early for autoTitle in runSvc
const checkpointPort = sqliteCheckpointReadAdapter(db);

// Run feature — M9 subprocess model
const runSvc = createRunService({
  supervisor,
  eventLog,
  maxConcurrentRuns: config.maxConcurrentRuns,
  threads,
  idGen: ulid,
  autoTitle: {
    getThread: async (tid) => {
      try {
        const r = await threadSvc.getById(tid);
        return { title: r.title };
      } catch {
        return null;
      }
    },
    getMessages: async (tid) =>
      (await checkpointPort.getMessages(tid)) as
        | import("@my-agent-team/core").Message[]
        | null,
    setTitle: async (tid, title) => {
      await threadSvc.update(tid, { title });
    },
    llm: { apiKey: config.anthropicApiKey },
  },
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
    storage: {
      eventLog: { kind: "sqlite" as const, path: `${config.dataDir}/events.db` },
      checkpointer: { kind: "sqlite" as const, path: `${config.dataDir}/backend.db` },
    },
    ...overrides,
  });
  return JSON.stringify(spec);
}

// Checkpoint feature
const checkpointWritePort = sqliteCheckpointWriteAdapter(db);
const checkpointSvc = createCheckpointService({ port: checkpointPort });

// M10: Conversation feature
const convPort = sqliteConversationAdapter(db);
const activeConversations = new Set<string>();

const convSvc = createConversationService({
  port: convPort,
  checkpointRead: checkpointPort,
  checkpointWrite: checkpointWritePort,
  activeConversations,
  maxConsecutiveAgentHops: 8,

  // C1 fix: build real AgentSpec JSON for forked agent runs
  forkRun: (runId, threadId, _specJson, ctx) => {
    // Ensure thread row exists (lazy at first fork — D17)
    const existing = db.query("SELECT id FROM threads WHERE id = ?").get(threadId) as { id: string } | undefined;
    if (!existing) {
      db.run(
        "INSERT INTO threads (id, agent_id, title, kind, created_at, updated_at) VALUES (?, ?, ?, 'conversation', ?, ?)",
        [threadId, ctx.agentId, `Conversation ${ctx.conversationId}`, Date.now(), Date.now()],
      );
    }

    // Build full spec JSON (C1 fix)
    const agentRow = db.query(
      "SELECT workspace_path, model_provider, model_name, model_base_url, permission_mode, max_steps FROM agents WHERE id = ?",
    ).get(ctx.agentId) as {
      workspace_path: string;
      model_provider: string;
      model_name: string;
      model_base_url: string | null;
      permission_mode: string;
      max_steps: number | null;
    } | undefined;
    if (!agentRow) throw new Error(`Agent not found: ${ctx.agentId}`);

    const spec = AgentSpecV1.parse({
      schemaVersion: "1",
      workspace: agentRow.workspace_path,
      threadId,
      conversationId: ctx.conversationId,
      senderMemberId: ctx.agentMemberId,
      model: {
        provider: agentRow.model_provider as "anthropic",
        model: agentRow.model_name,
        ...(agentRow.model_base_url ? { baseURL: agentRow.model_base_url } : {}),
      },
      apiKey: config.anthropicApiKey,
      permissionMode: agentRow.permission_mode as "ask" | "auto" | "deny" | undefined,
      maxSteps: agentRow.max_steps ?? undefined,
      input: "", // input is in the thread.messages already (via broadcast projection)
      runId,
      storage: {
        eventLog: { kind: "sqlite" as const, path: `${config.dataDir}/events.db` },
        checkpointer: { kind: "sqlite" as const, path: `${config.dataDir}/backend.db` },
      },
    });
    const specJson = JSON.stringify(spec);
    return supervisor.fork(runId, threadId, specJson);
  },

});

// Run legacy backfill (idempotent)
backfillLegacyThreads(db, convPort);

// C2 + D19 fix: register conversation-level onRunComplete (multi-listener supervisor)
supervisor.onRunComplete((threadId, runId) => {
  // Scan active conversations for a matching threadId (deriveThreadId = cid:memberId)
  for (const cid of activeConversations) {
    if (threadId.startsWith(`${cid}:`)) {
      // C2: Release the conversation lock
      convSvc.completeRun(cid, threadId, runId);

      // D19: Fire-and-forget — read agent output from event_log (one-shot, run has exited), append to ledger, broadcast
      void (async () => {
        try {
          const events = await eventLog.read({ runId });
          const msgs: Array<{ role: string; content: unknown }> = [];
          for (const rec of events) {
            if (rec.event.type === "message") {
              msgs.push({ role: rec.event.payload.role, content: rec.event.payload.content });
            }
          }
          const lastAssistant = msgs.filter((m) => m.role === "assistant").pop();
          if (lastAssistant) {
            const text = typeof lastAssistant.content === "string"
              ? lastAssistant.content
              : Array.isArray(lastAssistant.content)
                ? lastAssistant.content.filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("")
                : String(lastAssistant.content);

            const senderMemberId = threadId.includes(":") ? threadId.split(":").pop()! : threadId;
            const seq = convPort.appendLedgerEntry({
              conversationId: cid,
              senderMemberId,
              addressedTo: [],
              kind: "message",
              content: JSON.stringify({ text }),
              ts: Date.now(),
            });
            await convSvc.broadcastMessage({
              seq,
              conversationId: cid,
              senderMemberId,
              addressedTo: [],
              kind: "message",
              content: JSON.stringify({ text }),
              ts: Date.now(),
            });
          }
        } catch (err) {
          console.error(`[conversation] D19 error for ${runId}:`, err instanceof Error ? err.message : String(err));
        }
      })();
      break;
    }
  }
});

// HTTP router
// D14: startup assertion — resume support requires thread lookup
const getThreadIdForRun = async (runId: string) => {
  const row = db.query("SELECT thread_id FROM run WHERE run_id = ?").get(runId) as { thread_id: string } | undefined;
  if (!row) throw new Error(`Run not found: ${runId}`);
  return row.thread_id;
};

const router = createRouter(config.authToken, {
  agents: agentRoutes(agentSvc),
  threads: threadRoutes(threadSvc),
  runs: runRoutes(runSvc, buildSpecJson, getThreadIdForRun),
  checkpoints: checkpointRoutes(checkpointSvc),
  conversations: conversationRoutes(convSvc, ulid),

  // H4: Legacy thread→conversation forwarding for POST /threads/:id/runs
  resolveLegacyThreadRun: async (threadId: string) => {
    // Only forward if this is actually a conversation thread, not an agent_thread
    // (backfillLegacyThreads creates conversation entries for all threads)
    const thread = threadPort.findById(threadId);
    if (thread?.kind === "agent_thread") return null;
    const conv = convPort.getConversation(threadId);
    if (!conv) return null; // Not a conversation — use legacy path
    const agentMembers = convPort.getAgentMembers(threadId);
    if (agentMembers.length === 0) return null; // No agent members yet — use legacy path
    if (agentMembers.length === 1) {
      return { action: "forward" as const, conversationId: threadId, agentMemberId: agentMembers[0]!.memberId };
    }
    return { action: "reject" as const, reason: "Thread is part of a multi-member conversation; use POST /api/conversations/:id/messages" };
  },
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

  await supervisor.dispose();
  db.close();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
