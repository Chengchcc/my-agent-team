import { Database } from "bun:sqlite";
import type { Message } from "@my-agent-team/core";
import { sqliteEventLog } from "@my-agent-team/event-log";
import { createSocketClient } from "@my-agent-team/runner-protocol";
import {
  createRuntimeTracer,
  resolveObservabilityConfig,
} from "@my-agent-team/runtime-observability";
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
import type { ConversationPort } from "./features/conversation/ports.js";
import { createRunService, runRoutes } from "./features/run/index.js";
import type { RunnerRegistry } from "./features/run/runner-registry.js";
import { DevRunnerRegistry } from "./features/run/runner-registry.js";
import { ProdRunnerRegistry } from "./features/run/runner-registry.js";
import { RunSupervisor } from "./features/run/supervisor.js";
import { RuntimeOpsStore, createRuntimeOpsService, opsRoutes } from "./features/runtime-ops/index.js";
import { runEventsDbMigrations } from "./features/run/events-db-migrations.js";
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
// M16: Shared events DB — runEventsDbMigrations creates all tables (run, attempt, run_ops_event, etc.)
const eventsDb = new Database(`${config.dataDir}/events.db`);
eventsDb.exec("PRAGMA journal_mode=WAL");
eventsDb.exec("PRAGMA busy_timeout=5000");
runEventsDbMigrations(eventsDb);

const eventLog = sqliteEventLog({ db: `${config.dataDir}/events.db` });
const obsConfig = resolveObservabilityConfig({ serviceName: "backend" });
const tracer = createRuntimeTracer(obsConfig);
const opsStore = new RuntimeOpsStore(eventsDb);

const supervisor = new RunSupervisor({
  eventLog,
  config,
  registry,
  opsStore,
  tracer,
  db: eventsDb,
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

// Checkpoint feature
const threadProjectionWritePort = sqliteThreadProjectionWriteAdapter(db);
const threadProjectionSvc = createThreadProjectionService({ port: threadProjectionPort });

// M10: Conversation feature
const convPort = sqliteConversationAdapter(db);
/** Build preloaded Message[] for a run from the conversation ledger.
 *  Eliminates the thread_projection round-trip: the ledger is the canonical
 *  source, and materializing to thread_projection eagerly was a vestige of
 *  M9's checkpointer-only recovery path. */
function buildPreloadedMessages(
  port: ConversationPort,
  conversationId: string,
  memberId: string,
): Message[] {
  const entries = port.getLedgerEntries(conversationId);
  const msgs: Message[] = [];
  for (const entry of entries) {
    if (entry.kind !== "message") continue;
    const role = entry.senderMemberId === memberId ? "assistant" : "user";
    let content: unknown;
    try { content = JSON.parse(entry.content); } catch { content = entry.content; }
    if (content && typeof content === "object" && !Array.isArray(content)) {
      const c = content as Record<string, unknown>;
      if ("text" in c && typeof c.text === "string") {
        content = c.text;
      } else if ("blocks" in c && Array.isArray(c.blocks)) {
        content = c.blocks;
      }
    }
    if (typeof content === "string") {
      msgs.push({ role: role as "user" | "assistant", content });
    } else if (Array.isArray(content)) {
      msgs.push({ role: role as "user" | "assistant", content: content as Message["content"] });
    }
  }
  return msgs;
}

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

    // Build preloaded messages from the conversation ledger (canonical source).
    // No longer reads from thread_projection — the ledger is the single source
    // of truth for conversation history. thread_projection is a read-only cache
    // for SSE subscribers, not a required step in the hot path.
    const preloadedMessages = buildPreloadedMessages(
      convPort,
      ctx.conversationId,
      ctx.agentMemberId,
    );

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

    // M16: Generate trace context and propagate to daemon
    const trace = tracer.inject();

    const { attemptId } = await supervisor.startMainRun(runId, threadId, spec, {
      preloadedMessages,
      surfaceContext,
      trace,
    });

    // M16: Record run origin for diagnostics and server-side retry
    opsStore.insertRunOrigin({
      runId,
      conversationId: ctx.conversationId,
      sourceLedgerSeq: ctx.ledgerSeq,
      agentMemberId: ctx.agentMemberId,
      surface: surfaceContext?.surface ?? "web",
      traceId: trace.traceId,
      traceparent: trace.traceparent,
      idempotencyKey: `${ctx.conversationId}:${ctx.ledgerSeq}:run`,
      createdAt: Date.now(),
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

/** Conversation Projection handler: on run complete, project messages to conversation ledger
 *  and trigger @-mentioned agents. Registered as supervisor.onRunComplete listener. */
async function onRunComplete(threadId: string, runId: string): Promise<void> {
  // M14.3: reflect run自身结束 — 不放会话锁、不做 Conversation Projection、不递归
  if (threadId.startsWith("reflect:")) return;
  for (const cid of activeConversations) {
    if (threadId.startsWith(`${cid}:`)) {
      // C2: Release the conversation lock
      convSvc.completeRun(cid, threadId, runId);

      // Side effects deferred to run completion: the onRunEvent callback above
      // has already projected messages to the ledger and accumulated @mentions
      // + the last todo_update. Consume the accumulator now (no second EventLog read).
      const acc = runAccumulators.get(runId);
      if (acc) {
        runAccumulators.delete(runId);

        try {
          if (acc.lastTodoUpdate) {
            await convSvc.appendTodo(cid, acc.senderMemberId, acc.lastTodoUpdate.todos);
          }
          if (acc.mentionedMemberIds.size > 0) {
            void convSvc.triggerMentionedAgents({
              conversationId: cid,
              senderMemberId: acc.senderMemberId,
              addressedTo: [...acc.mentionedMemberIds],
            });
          }
        } catch (err) {
          console.error(
            `[conversation] Conversation Projection error for ${runId}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // M14.7: Reflection is now orchestrated by the daemon control loop.
      // Backend only sends run_finalized ACK; daemon fires reflection after receiving it.
      break;
    }
  }
}

supervisor.onRunComplete(onRunComplete);

// ── Per-run accumulator for side-effects that need the full output ──
// Each onRunEvent tick appends to this; onRunComplete consumes and cleans up.
// Eliminates the second EventLog read (eventLog.read({runId})) that the old
// batch path needed — events are processed exactly once.

interface RunAccumulator {
  senderMemberId: string;
  mentionedMemberIds: Set<string>;
  lastTodoUpdate: { todos: unknown } | null;
}

const runAccumulators = new Map<string, RunAccumulator>();

function getOrCreateAccumulator(runId: string, senderMemberId: string): RunAccumulator {
  let acc = runAccumulators.get(runId);
  if (!acc) {
    acc = { senderMemberId, mentionedMemberIds: new Set(), lastTodoUpdate: null };
    runAccumulators.set(runId, acc);
  }
  return acc;
}

/** Conversation Projection (incremental): project a single message produced mid-run into the
 *  conversation ledger as soon as it is durably logged, so multi-round progress
 *  becomes visible while the run is still in flight.
 *
 *  Also accumulates @mention targets for resolution at run completion — each event
 *  is processed exactly once (no second EventLog read). */
async function projectRunMessageToLedger(
  threadId: string,
  runId: string,
  role: string,
  content: unknown,
): Promise<void> {
  // M14.3: reflect runs are not projected to any conversation.
  if (threadId.startsWith("reflect:")) return;
  if (role !== "assistant" && role !== "user") return;
  if (typeof content === "string" && content.trim().length === 0) return;
  if (Array.isArray(content) && content.length === 0) return;

  // Filter out tool-only rounds — they render as [Unsupported content] in Lark
  // and provide no value to humans mid-execution.
  if (role === "assistant" && Array.isArray(content)) {
    const hasText = content.some((b: unknown) =>
      typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text",
    );
    if (!hasText) return;
  }

  const cid = [...activeConversations].find((c) => threadId.startsWith(`${c}:`));
  if (!cid) return;
  const senderMemberId = threadId.includes(":") ? threadId.split(":").pop()! : threadId;

  const contentWithRunId =
    role === "assistant"
      ? typeof content === "string"
        ? { text: content, runId, _preliminary: true }
        : Array.isArray(content)
          ? { blocks: content, runId, _preliminary: true }
          : typeof content === "object" && content !== null
            ? { ...(content as Record<string, unknown>), runId, _preliminary: true }
            : content
      : content;

  const ts = Date.now();
  const serialized = JSON.stringify(contentWithRunId);

  // Dedup: check if this exact (runId, content) pair already exists in the
  // ledger. Guards against replay when the supervisor replays the same
  // EventLog events after reconnect/recover.
  if (convPort.hasLedgerContent?.(runId, serialized)) return;

  const seq = convPort.appendLedgerEntry({
    conversationId: cid,
    senderMemberId,
    addressedTo: [],
    kind: "message",
    content: serialized,
    ts,
    runId,
  });
  // Broadcast to OTHER members only — the sender's own live run thread already
  // has the real message from the agent loop (rt.save()), so writing it again
  // via broadcast would double-insert and cause checkpoint lock contention.
  await convSvc.broadcastMessage(
    {
      seq,
      conversationId: cid,
      senderMemberId,
      addressedTo: [],
      kind: "message",
      content: serialized,
      ts,
    },
    { excludeMemberId: senderMemberId },
  );
}

supervisor.onRunEvent((threadId, runId, event) => {
  // ── todo_update: store the last snapshot for onRunComplete ──
  if (event.type === "todo_update") {
    const cid = [...activeConversations].find((c) => threadId.startsWith(`${c}:`));
    if (!cid) return;
    const senderMemberId = threadId.includes(":") ? threadId.split(":").pop()! : threadId;
    const acc = getOrCreateAccumulator(runId, senderMemberId);
    const payload = (event as { payload?: { todos?: unknown } }).payload;
    if (payload?.todos) acc.lastTodoUpdate = { todos: payload.todos };
    return;
  }

  // ── message: project to ledger + accumulate @mentions ──
  if (event.type !== "message") return;
  const payload = event.payload as { role?: string; content?: unknown } | undefined;
  if (!payload) return;
  const role = payload.role ?? "";
  const content = payload.content;

  // Accumulate @mentions from assistant text (for deferred trigger at run end)
  if (role === "assistant") {
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b: unknown) => (b as { type: string }).type === "text")
            .map((b: unknown) => (b as { text: string }).text)
            .join(" ")
        : "";
    if (text) {
      const cid = [...activeConversations].find((c) => threadId.startsWith(`${c}:`));
      if (cid) {
        const senderMemberId = threadId.includes(":") ? threadId.split(":").pop()! : threadId;
        const acc = getOrCreateAccumulator(runId, senderMemberId);
        const roster = convPort.getMembers(cid);
        for (const m of roster) {
          if (m.kind !== "agent" || m.memberId === senderMemberId) continue;
          const label = m.displayName ?? m.memberId;
          const re = new RegExp(`@${escapeRegExp(label)}(?=\\s|[,.!?;:]|$)`, "g");
          if (re.test(text) || text.includes(`@${m.memberId}`)) {
            acc.mentionedMemberIds.add(m.memberId);
          }
        }
      }
    }
  }

  // Fire-and-forget the ledger write (projectRunMessageToLedger does its own guards)
  projectRunMessageToLedger(threadId, runId, role, content).catch((err) => {
    console.error(
      `[conversation] projectRunMessageToLedger failed for ${runId}:`,
      err instanceof Error ? err.message : String(err),
    );
  });
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

// M16.2: Pre-populate agent name cache for ops DTOs (sync query from backend.db)
const agentNames = new Map<string, string>();
{
  const rows = db.query("SELECT id, name FROM agents").all() as { id: string; name: string }[];
  for (const r of rows) agentNames.set(r.id, r.name);
}

// M16: Runtime ops service — exposes run diagnostics, health, and control
const opsSvc = createRuntimeOpsService({
  db: eventsDb,
  opsStore,
  supervisor,
  registry,
  heartbeatTimeoutMs: config.heartbeatTimeoutMs,
  eventLog,
  getAgentName: (agentId) => agentNames.get(agentId),
});

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
  ops: opsRoutes(opsSvc),
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
