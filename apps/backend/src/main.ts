import type { Message } from "@my-agent-team/core";
import { sqliteEventLog } from "@my-agent-team/event-log";
import { createSocketClient } from "@my-agent-team/runner-protocol";
import { loadConfig } from "./config.js";
import { sqliteAgentAdapter } from "./features/agent/adapter-sqlite.js";
import { AgentBusyError, agentRoutes, createAgentService } from "./features/agent/index.js";
import { createAgentIdentityStore } from "./features/agent/identity-store.js";
import {
  sqliteThreadProjectionReadAdapter,
  sqliteThreadProjectionWriteAdapter,
} from "./features/thread-projection/adapter-sqlite.js";
import {
  threadProjectionRoutes,
  createThreadProjectionService,
} from "./features/thread-projection/index.js";
import {
  conversationRoutes,
  createConversationService,
  sqliteConversationAdapter,
} from "./features/conversation/index.js";
import { createRunService, runRoutes } from "./features/run/index.js";
import type { RunnerRegistry } from "./features/run/runner-registry.js";
import { DevRunnerRegistry } from "./features/run/runner-registry.js";
import { ProdRunnerRegistry } from "./features/run/runner-registry.js";
import { RunSupervisor } from "./features/run/supervisor.js";
import {
  CliSetupProvisioner,
  DevLarkBotRegistry,
  LarkSetupManager,
  ProdLarkBotRegistry,
  larkProfileInit,
  sanitizeLarkCliOutput,
} from "./features/lark-bot/index.js";
import type { LarkBotRegistry } from "./features/lark-bot/index.js";
import { withLarkOrchestration } from "./features/agent/with-lark-orchestration.js";
import { createRouter } from "./http/router.js";
import { ulid } from "./infra/ids.js";
import { openDb } from "./infra/sqlite/db.js";
import { materializeWorkspace, purgeWorkspace } from "./infra/workspace.js";
import { createServer } from "./server.js";

const config = loadConfig();
const db = openDb(`${config.dataDir}/backend.db`);

// Infrastructure
const threads = new Set<string>();

// M14.7: RunnerRegistry — dev spawns daemons, prod resolves endpoints
const runnerEnv = process.env.RUNNER_ENV ?? "dev";
const registry: RunnerRegistry =
  runnerEnv === "prod"
    ? new ProdRunnerRegistry({
        endpointResolver: {
          resolve: async (agentId: string) => ({
            kind: "unix" as const,
            socketPath: `/run/runners/${agentId}/runner.sock`,
          }),
        },
        transportFactory: {
          create: (endpoint: { kind: "unix"; socketPath: string }) =>
            createSocketClient({ socketPath: endpoint.socketPath }),
        },
      })
    : new DevRunnerRegistry({
        dataDir: config.dataDir,
        daemonBin: `${import.meta.dir}/../../../packages/runner-daemon/src/bin.ts`,
        transportFactory: (socket) => createSocketClient({ socketPath: socket }),
        backendUrl: `http://${config.host}:${config.port}`,
        backendAuthToken: config.authToken,
      });

// M9: EventLog + Supervisor
const eventLog = sqliteEventLog({ db: `${config.dataDir}/events.db` });
const supervisor = new RunSupervisor({
  eventLog,
  config,
  registry,
});

// M15: Lark-bot registry (spawns per-agent lark-bot processes)
const larkBotRegistry: LarkBotRegistry =
  runnerEnv === "prod"
    ? new ProdLarkBotRegistry()
    : new DevLarkBotRegistry({
        dataDir: config.dataDir,
        larkBotBin: `${import.meta.dir}/../../lark-bot/src/main.ts`,
        backendUrl: `http://${config.host}:${config.port}`,
      });

// Agent feature
const agentPort = sqliteAgentAdapter(db);
const agentSvcRaw = createAgentService({
  port: agentPort,
  idGen: ulid,
  workspaceRoot: config.workspaceRoot,
  materializeWorkspace: async (agentId, template) => {
    // Legacy workspace (kept for backward compat)
    const legacyPath = await materializeWorkspace({
      workspaceRoot: config.workspaceRoot,
      agentId,
      template,
      templateDir: config.templateDir,
    });
    // Seed runner sharedRoot so identity API and runtime share one source
    const { runnerWorkspacePaths, ensureRunnerWorkspace, migrateLegacyWorkspaceToShared } =
      await import("./infra/runner-workspace.js");
    const paths = runnerWorkspacePaths(config.dataDir, agentId);
    await ensureRunnerWorkspace(paths);
    // Immediately seed identity files from legacy workspace. Don't wait for
    // identity API lazy migration or first runner spawn — new agents need
    // BOOTSTRAP.md available before their first run.
    await migrateLegacyWorkspaceToShared(paths.sharedRoot, legacyPath);
    return legacyPath;
  },

  // M11 hardDelete dependencies — all closures from composition root
  purgeWorkspace: async (agentId) => {
    // Legacy workspace
    await purgeWorkspace({ workspaceRoot: config.workspaceRoot, agentId });
    // Runner workspace (shared/private/state/socket/pid)
    const { purgeRunnerWorkspace } = await import("./infra/runner-workspace.js");
    await purgeRunnerWorkspace({ dataDir: config.dataDir, agentId });
  },

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

// M15: Wrap agent service with lark-bot orchestration (profile init + registry lifecycle)
const agentSvc = withLarkOrchestration({
  service: agentSvcRaw,
  profileInit: larkProfileInit,
  ensureBot: (id, botDisplayName, larkProfile) =>
    larkBotRegistry.ensureLarkBot(id, botDisplayName, larkProfile),
  stopBot: (id) => larkBotRegistry.stopLarkBot(id),
});

// Checkpoint read adapter — needed early for autoTitle in runSvc
const threadProjectionPort = sqliteThreadProjectionReadAdapter(db);

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
    getMessages: async (tid) => (await threadProjectionPort.getMessages(tid)) as Message[] | null,
    setTitle: async (tid, title) => {
      const cid = tid.includes(":") ? tid.split(":")[0]! : tid;
      convPort.setConversationTitle(cid, title);
    },
    llm: { apiKey: config.anthropicApiKey },
  },
});

// Build spec helper — returns V2 spec object for daemon transport
/** M14.7: Single spec builder for all run modes. Reads agent config for model/permission/maxSteps. */
async function buildAgentSpecV2(
  threadId: string,
  input: string,
  overrides?: {
    runId?: string;
    mode?: "run" | "resume" | "reflect";
    resumeCommand?: { approved: boolean; message?: string };
    conversationId?: string;
    senderMemberId?: string;
    parentRunId?: string;
  },
): Promise<Record<string, unknown>> {
  const cid = threadId.split(":")[0]!;
  const memberId = threadId.split(":").slice(1).join(":");
  const member = db
    .query("SELECT agent_id FROM member WHERE conversation_id = ? AND member_id = ?")
    .get(cid, memberId) as { agent_id: string } | undefined;
  const agentId = member?.agent_id ?? memberId;
  const agent = await agentSvc.getById(agentId);
  return {
    schemaVersion: "2",
    agentId,
    threadId,
    runId: overrides?.runId ?? crypto.randomUUID(),
    mode: overrides?.mode ?? "run",
    input,
    model: {
      provider: agent.modelProvider,
      model: agent.modelName,
      ...(agent.modelBaseUrl ? { baseURL: agent.modelBaseUrl } : {}),
    },
    permissionMode: agent.permissionMode ?? "ask",
    maxSteps: agent.maxSteps ?? undefined,
    ...overrides,
  };
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
const threadProjectionWritePort = sqliteThreadProjectionWriteAdapter(db);
const threadProjectionSvc = createThreadProjectionService({ port: threadProjectionPort });

// M10: Conversation feature
const convPort = sqliteConversationAdapter(db);
const activeConversations = new Set<string>();

const convSvc = createConversationService({
  port: convPort,
  threadProjectionRead: threadProjectionPort,
  threadProjectionWrite: threadProjectionWritePort,
  activeConversations,
  maxConsecutiveAgentHops: 8,
  idGen: ulid,

  // ThreadId = conversationId:memberId (derived, not persisted).
  // The threads table is legacy — runtime only needs the derived key.
  forkRun: async (runId, threadId, ctx) => {
    const spec = await buildAgentSpecV2(threadId, "", {
      runId,
      conversationId: ctx.conversationId,
      senderMemberId: ctx.agentMemberId,
    });
    const preloadedMessages = (await threadProjectionPort.getMessages(threadId)) as
      | readonly Message[]
      | undefined;

    // M15.1: Detect Lark surface by checking for human members with lark: userRef
    const members = convPort.getMembers(ctx.conversationId);
    const isLarkConversation = members.some(
      (m) => m.kind === "human" && m.userRef?.startsWith("lark:"),
    );
    const surfaceContext = isLarkConversation
      ? {
          surface: "lark" as const,
          conversationId: ctx.conversationId,
          runId,
          capabilities: ["start_new_conversation" as const],
        }
      : undefined;

    const { attemptId } = await supervisor.startMainRun(runId, threadId, spec, {
      preloadedMessages,
      surfaceContext,
    });
    return { runId, attemptId };
  },

  /** M15.1: Verify a run belongs to a conversation before surface control writes. */
  verifyRunOwnsConversation: async (runId, conversationId) => {
    const runDb = supervisor.getDb();
    const row = runDb
      .query("SELECT thread_id FROM run WHERE run_id = ?")
      .get(runId) as { thread_id: string } | undefined;
    if (!row) throw new Error(`run not found: ${runId}`);
    if (!row.thread_id.startsWith(`${conversationId}:`)) {
      throw new Error(
        `run ${runId} does not belong to conversation ${conversationId}`,
      );
    }
  },
});

/** D19 handler: on run complete, project messages to conversation ledger
 *  and trigger @-mentioned agents. Registered as supervisor.onRunComplete listener. */
async function onRunComplete(threadId: string, runId: string): Promise<void> {
  // M14.3: reflect run自身结束 — 不放会话锁、不D19、不递归
  if (threadId.startsWith("reflect:")) return;
  for (const cid of activeConversations) {
    if (threadId.startsWith(`${cid}:`)) {
      // C2: Release the conversation lock
      convSvc.completeRun(cid, threadId, runId);

      // D19: Write all assistant messages from this run to the ledger.
      // M14.7: Awaited before run_finalized ACK (no longer fire-and-forget).
      try {
        const events = await eventLog.read({ runId });

        const conversationMsgs = events
          .filter((rec) => rec.event.type === "message")
          .map((rec) => rec.event.payload as { role: string; content: unknown })
          .filter((p) => p.role === "assistant" || p.role === "user");

        const senderMemberId = threadId.includes(":") ? threadId.split(":").pop()! : threadId;

        // M14.6: Capture last todo_update snapshot and persist to ledger.
        const lastTodoUpdate = events.filter((rec) => rec.event.type === "todo_update").pop();
        if (lastTodoUpdate) {
          const payload = (lastTodoUpdate.event as { payload: { todos: unknown } }).payload;
          await convSvc.appendTodo(cid, senderMemberId, payload.todos);
        }

        // M14.4: Parse @mentions from agent output for agent-to-agent triggering
        const roster = convPort.getMembers(cid);
        const mentionedMemberIds = new Set<string>();

        for (const msg of conversationMsgs) {
          const content = msg.content;
          if (typeof content === "string" && content.trim().length === 0) continue;
          if (Array.isArray(content) && content.length === 0) continue;

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

          // M15.1: Inject runId so lark-bot can skip card-delivered final text
          const contentWithRunId =
            msg.role === "assistant"
              ? typeof content === "string"
                ? { text: content, runId }
                : Array.isArray(content)
                  ? { blocks: content, runId }
                  : typeof content === "object" && content !== null
                    ? { ...(content as Record<string, unknown>), runId }
                    : content
              : content;

          const seq = convPort.appendLedgerEntry({
            conversationId: cid,
            senderMemberId,
            addressedTo: [...mentionedMemberIds],
            kind: "message",
            content: JSON.stringify(contentWithRunId),
            ts: Date.now(),
          });
          await convSvc.broadcastMessage({
            seq,
            conversationId: cid,
            senderMemberId,
            addressedTo: [...mentionedMemberIds],
            kind: "message",
            content: JSON.stringify(contentWithRunId),
            ts: Date.now(),
          });
        }

        // M14.4: Trigger @-mentioned agents (agent-to-agent chain)
        if (mentionedMemberIds.size > 0) {
          void convSvc.triggerMentionedAgents({
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

      // M14.7: Reflection is now orchestrated by the daemon control loop.
      // Backend only sends run_finalized ACK; daemon fires reflection after receiving it.
      break;
    }
  }
}

supervisor.onRunComplete(onRunComplete);

// HTTP router
// D14: startup assertion — resume support requires thread lookup
const getThreadIdForRun = async (runId: string) => {
  const row = db.query("SELECT thread_id FROM run WHERE run_id = ?").get(runId) as
    | { thread_id: string }
    | undefined;
  if (!row) throw new Error(`Run not found: ${runId}`);
  return row.thread_id;
};

const identityStore = createAgentIdentityStore({
  dataDir: config.dataDir,
  getAgent: (id) => agentSvc.getById(id),
});

// M15.1: Lark profile setup manager — lazily created on first setup request
let setupManager: LarkSetupManager | undefined;
function getSetupManager(): LarkSetupManager {
  if (!setupManager) {
    const provisioner = new CliSetupProvisioner();
    setupManager = new LarkSetupManager(provisioner, async (session) => {
      await agentSvcRaw.update(session.agentId, {
        lark: {
          enabled: true,
          botDisplayName: session.botDisplayName ?? undefined,
        },
      });
      await larkBotRegistry.ensureLarkBot(
        session.agentId,
        session.botDisplayName,
        session.profileRef,
      );
      console.log(`[lark-setup] completed for ${session.agentId}, profile=${session.profileRef}`);
    });
  }
  return setupManager;
}

const router = createRouter(config.authToken, {
  agents: agentRoutes(
    agentSvc,
    identityStore,
    (agentId) => larkBotRegistry.statusOf(agentId),
    getSetupManager,
  ),
  // threads: removed — conversation is the user-facing concept
  runs: runRoutes(runSvc, buildAgentSpecV2, getThreadIdForRun),
  threadProjections: threadProjectionRoutes(threadProjectionSvc),
  conversations: conversationRoutes(convSvc, ulid),
});

// Server
const server = createServer(config, router);

// M9: Re-discover live runs on startup
await supervisor.rediscover(eventLog);

server.start();
console.log(`[backend] listening on ${config.host}:${config.port}`);

// M15: Launch lark-bots for enabled agents on startup
(async () => {
  const allAgents = await agentSvc.list(true);
  for (const agent of allAgents) {
    if (agent.larkEnabled && agent.larkProfileRef) {
      larkBotRegistry
        .ensureLarkBot(agent.id, agent.larkBotDisplayName, agent.larkProfileRef)
        .catch((err) => {
          console.error(`[lark] failed to start bot for ${agent.id}:`, err);
        });
    }
  }
})();

// Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`[backend] ${signal} received, shutting down...`);
  server.stop();

  // M14.7: Cancel all active runs (daemon transport will handle abort)
  supervisor.cancelAll();
  // Give daemons time to process abort messages
  await new Promise((r) => setTimeout(r, config.cancelGraceMs));

  await supervisor.dispose();
  // M14.7: Dispose daemon registry (kills spawned daemon processes)
  await registry.dispose?.();
  // M15: Dispose lark-bot registry (SIGTERM all bot processes)
  await larkBotRegistry.dispose();
  setupManager?.dispose();
  db.close();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
