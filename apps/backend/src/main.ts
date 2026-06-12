import { existsSync } from "node:fs";
import { AgentSpecV1 } from "@my-agent-team/agent-spec";
import type { Message } from "@my-agent-team/core";
import { sqliteEventLog } from "@my-agent-team/event-log";
import { loadConfig } from "./config.js";
import { sqliteAgentAdapter } from "./features/agent/adapter-sqlite.js";
import { AgentBusyError, agentRoutes, createAgentService } from "./features/agent/index.js";
import {
  sqliteCheckpointReadAdapter,
  sqliteCheckpointWriteAdapter,
} from "./features/checkpoint/adapter-sqlite.js";
import { checkpointRoutes, createCheckpointService } from "./features/checkpoint/index.js";
import {
  conversationRoutes,
  createConversationService,
  sqliteConversationAdapter,
} from "./features/conversation/index.js";
import { createRunService, runRoutes } from "./features/run/index.js";
import { orchestrateReflection } from "./features/run/reflect-orchestrator.js";
import { RunSupervisor } from "./features/run/supervisor.js";
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
        edb.run(
          "DELETE FROM attempt WHERE run_id IN (SELECT run_id FROM run WHERE thread_id = ?)",
          [tid],
        );
        edb.run("DELETE FROM run WHERE thread_id = ?", [tid]);
      }
    });
    tx(threadIds);
  },

  listThreadIds: async (agentId) =>
    (
      db
        .query("SELECT conversation_id || ':' || member_id AS id FROM member WHERE agent_id = ?")
        .all(agentId) as { id: string }[]
    ).map((r) => r.id),

  assertNoActiveRun: (agentId) => {
    const edb = supervisor.getDb();
    const threadIds = (
      db
        .query("SELECT conversation_id || ':' || member_id AS id FROM member WHERE agent_id = ?")
        .all(agentId) as { id: string }[]
    ).map((r) => r.id);
    if (threadIds.length === 0) return;
    const placeholders = threadIds.map(() => "?").join(",");
    const busy = edb
      .query(
        `SELECT 1 FROM attempt WHERE ended_at IS NULL
         AND run_id IN (SELECT run_id FROM run WHERE thread_id IN (${placeholders})) LIMIT 1`,
      )
      .all(...threadIds);
    if (busy.length > 0) throw new AgentBusyError(agentId);
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
      // Check conversation title (covers both conversation threads and legacy)
      const cid = tid.includes(":") ? tid.split(":")[0]! : tid;
      const conv = convPort.getConversation(cid);
      if (conv?.title) return { title: conv.title };
      return conv ? { title: null } : null;
    },
    getMessages: async (tid) => (await checkpointPort.getMessages(tid)) as Message[] | null,
    setTitle: async (tid, title) => {
      const cid = tid.includes(":") ? tid.split(":")[0]! : tid;
      convPort.setConversationTitle(cid, title);
    },
    llm: { apiKey: config.anthropicApiKey },
  },
});

// Build spec helper — returns JSON string for subprocess env
async function buildSpecJson(
  threadId: string,
  input: string,
  overrides?: {
    runId?: string;
    mode?: "run" | "resume" | "reflect";
    resumeCommand?: { approved: boolean; message?: string };
    conversationId?: string;
    senderMemberId?: string;
  },
): Promise<string> {
  // Resolve agent from threadId: for conversation threads (cid:memberId),
  // ThreadId = cid:memberId — resolve agent via member row.
  const cid = threadId.split(":")[0]!;
  const memberId = threadId.split(":").slice(1).join(":");
  const member = db
    .query("SELECT agent_id FROM member WHERE conversation_id = ? AND member_id = ?")
    .get(cid, memberId) as { agent_id: string } | undefined;
  const agentId = member?.agent_id ?? memberId;
  const agent = await agentSvc.getById(agentId);

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

// M14.4: @mention parsing helpers for agent-to-agent triggering
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\&");
}

function extractText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: "text"; text: string } => (b as { type: string }).type === "text")
      .map((b) => b.text)
      .join(" ");
  }
  return null;
}
// Checkpoint feature
const checkpointWritePort = sqliteCheckpointWriteAdapter(db);
const checkpointSvc = createCheckpointService({ port: checkpointPort });

// M10: Conversation feature
const convPort = sqliteConversationAdapter(db);
const activeConversations = new Set<string>();
// M14.3: run metadata for post-run reflection decisions
const runMeta = new Map<string, { isGenesis: boolean; agentId: string; agentMemberId: string }>();

const convSvc = createConversationService({
  port: convPort,
  checkpointRead: checkpointPort,
  checkpointWrite: checkpointWritePort,
  activeConversations,
  maxConsecutiveAgentHops: 8,

  // ThreadId = conversationId:memberId (derived, not persisted).
  // The threads table is legacy — runtime only needs the derived key.
  forkRun: (runId, threadId, _specJson, ctx) => {
    // Build full spec JSON (C1 fix)
    const agentRow = db
      .query(
        "SELECT workspace_path, model_provider, model_name, model_base_url, permission_mode, max_steps FROM agents WHERE id = ?",
      )
      .get(ctx.agentId) as
      | {
          workspace_path: string;
          model_provider: string;
          model_name: string;
          model_base_url: string | null;
          permission_mode: string;
          max_steps: number | null;
        }
      | undefined;
    if (!agentRow) throw new Error(`Agent not found: ${ctx.agentId}`);

    // M14.3: Record genesis snapshot for post-run reflection gating
    const isGenesis = existsSync(`${agentRow.workspace_path}/BOOTSTRAP.md`);
    runMeta.set(runId, { isGenesis, agentId: ctx.agentId, agentMemberId: ctx.agentMemberId });

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
      isGenesis,
      storage: {
        eventLog: { kind: "sqlite" as const, path: `${config.dataDir}/events.db` },
        checkpointer: { kind: "sqlite" as const, path: `${config.dataDir}/backend.db` },
      },
    });
    const specJson = JSON.stringify(spec);
    return supervisor.fork(runId, threadId, specJson);
  },
});

// C2 + D19 fix: register conversation-level onRunComplete (multi-listener supervisor)
supervisor.onRunComplete((threadId, runId) => {
  // M14.3: reflect run自身结束 — 不放会话锁、不D19、不递归
  if (threadId.startsWith("reflect:")) return;
  // Scan active conversations for a matching threadId (deriveThreadId = cid:memberId)
  for (const cid of activeConversations) {
    if (threadId.startsWith(`${cid}:`)) {
      // C2: Release the conversation lock
      convSvc.completeRun(cid, threadId, runId);

      // D19: Write all assistant messages from this run to the ledger.
      // M14.3: Reflections run as independent post-run jobs with their own runId —
      // D19 reads only the main runId, so reflection messages are physically isolated.
      void (async () => {
        try {
          const events = await eventLog.read({ runId });

          const conversationMsgs = events
            .filter((rec) => rec.event.type === "message")
            .map((rec) => rec.event.payload as { role: string; content: unknown })
            .filter((p) => p.role === "assistant" || p.role === "user");

          const senderMemberId = threadId.includes(":") ? threadId.split(":").pop()! : threadId;

          // M14.6: Capture the last todo_update snapshot and persist to ledger.
          // Only the final snapshot is stored — intermediate updates are live-only
          // via the /runs/:id/events SSE channel. This avoids ledger spam while
          // ensuring the post-refresh state shows the definitive todo outcome.
          const lastTodoUpdate = events.filter((rec) => rec.event.type === "todo_update").pop();
          if (lastTodoUpdate) {
            const payload = (lastTodoUpdate.event as { payload: { todos: unknown } }).payload;
            await convSvc.appendTodo(cid, senderMemberId, payload.todos);
          }

          // M14.4: Pre-fetch roster for @mention resolution
          const roster = convPort.getMembers(cid);
          const mentionedMemberIds = new Set<string>();

          for (const msg of conversationMsgs) {
            const content = msg.content;
            if (typeof content === "string" && content.trim().length === 0) continue;
            if (Array.isArray(content) && content.length === 0) continue;

            // M14.4: Parse @mentions from agent output for agent-to-agent triggering
            if (msg.role === "assistant") {
              const text = extractText(content);
              if (text) {
                for (const m of roster) {
                  if (m.kind !== "agent" || m.memberId === senderMemberId) continue;
                  const label = m.displayName ?? m.memberId;
                  const re = new RegExp(`@${escapeRegExp(label)}(?=\\s|[,.!?;:]|$)`, "g");
                  if (re.test(text) || text.includes(`@${m.memberId}`)) {
                    mentionedMemberIds.add(m.memberId);
                  }
                }
              }
            }

            const seq = convPort.appendLedgerEntry({
              conversationId: cid,
              senderMemberId,
              addressedTo: [...mentionedMemberIds],
              kind: "message",
              content: JSON.stringify(content),
              ts: Date.now(),
            });
            await convSvc.broadcastMessage({
              seq,
              conversationId: cid,
              senderMemberId,
              addressedTo: [...mentionedMemberIds],
              kind: "message",
              content: JSON.stringify(content),
              ts: Date.now(),
            });
          }

          // M14.4: Trigger @-mentioned agents (agent-to-agent chain)
          if (mentionedMemberIds.size > 0) {
            convSvc.triggerMentionedAgents({
              conversationId: cid,
              senderMemberId,
              addressedTo: [...mentionedMemberIds],
            });
          }
        } catch (err) {
          console.error(
            `[conversation] D19 error for ${runId}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      })();

      // M14.3: post-run reflection — fire-and-forget, lock already released, independent run.
      // P1-a: resume runs don't populate runMeta (they bypass forkRun), so meta is undefined
      // and orchestrateReflection skips them. This matches the old runner behavior
      // (spec.mode !== "resume" gating) — the resume leg is the tail of a main turn whose
      // reflection already ran or wasn't needed. Known trade-off, not a bug.
      void orchestrateReflection(threadId, runId, cid, {
        runMeta,
        genId: ulid,
        buildSpecJson: (tid, input, opts) => buildSpecJson(tid, input, opts),
        fork: (rid, tid, json) => supervisor.fork(rid, tid, json),
        onError: (rid, err) =>
          console.error(
            `[reflect] failed for ${rid}:`,
            err instanceof Error ? err.message : String(err),
          ),
      });
      break;
    }
  }
});

// HTTP router
// D14: startup assertion — resume support requires thread lookup
const getThreadIdForRun = async (runId: string) => {
  const row = db.query("SELECT thread_id FROM run WHERE run_id = ?").get(runId) as
    | { thread_id: string }
    | undefined;
  if (!row) throw new Error(`Run not found: ${runId}`);
  return row.thread_id;
};

const router = createRouter(config.authToken, {
  agents: agentRoutes(agentSvc),
  // threads: removed — conversation is the user-facing concept
  runs: runRoutes(runSvc, buildSpecJson, getThreadIdForRun),
  checkpoints: checkpointRoutes(checkpointSvc),
  conversations: conversationRoutes(convSvc, ulid),
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
