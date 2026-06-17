import { Database } from "bun:sqlite";
import type { Message, MessageRevision } from "@my-agent-team/message";
import {
  createRuntimeTracer,
  resolveObservabilityConfig,
} from "@my-agent-team/runtime-observability";
import { loadConfig } from "./config.js";
import { createAgentSvc } from "./features/agent/agent-svc-factory.js";
import { createAgentIdentityStore } from "./features/agent/identity-store.js";
import { agentRoutes } from "./features/agent/index.js";
import {
  buildAgentSpecV2,
  createConversationFeature,
} from "./features/conversation/conv-svc-factory.js";
import { conversationRoutes, parseThreadId } from "./features/conversation/index.js";
import {
  escapeRegExp,
  getOrCreateAccumulator,
  onRunComplete,
  projectRunMessageToLedger,
} from "./features/conversation/projection.js";
import { sqliteEventLog } from "./features/event-log/index.js";
import { CliSetupProvisioner, LarkSetupManager } from "./features/lark-bot/index.js";
import { createLarkBotRegistry } from "./features/lark-bot/lark-bot-registry-factory.js";
import { runEventsDbMigrations } from "./features/run/events-db-migrations.js";
import { createRunService, runRoutes } from "./features/run/index.js";
import { createRunnerRegistry } from "./features/run/runner-registry-factory.js";
import { RunSupervisor } from "./features/run/supervisor.js";
import {
  createRuntimeOpsService,
  opsRoutes,
  RuntimeOpsStore,
} from "./features/runtime-ops/index.js";
import { threadProjectionRoutes } from "./features/thread-projection/index.js";
import { createRouter } from "./http/router.js";
import { ulid } from "./infra/ids.js";
import { openDb } from "./infra/sqlite/db.js";
import { createServer } from "./server.js";

// ─── Bootstrap ─────────────────────────────────────────────────

const config = loadConfig();
const db = openDb(`${config.dataDir}/backend.db`);

// EventLog + Supervisor
const eventsDb = new Database(`${config.dataDir}/events.db`);
eventsDb.exec("PRAGMA journal_mode=WAL");
eventsDb.exec("PRAGMA busy_timeout=5000");
runEventsDbMigrations(eventsDb);

const eventLog = sqliteEventLog({ db: `${config.dataDir}/events.db` });
const obsConfig = resolveObservabilityConfig({ serviceName: "backend" });
const tracer = createRuntimeTracer(obsConfig);
const opsStore = new RuntimeOpsStore(eventsDb);

const registry = createRunnerRegistry(config);
const supervisor = new RunSupervisor({
  eventLog,
  config,
  registry,
  opsStore,
  tracer,
  db: eventsDb,
});

// Feature services
const larkBotRegistry = createLarkBotRegistry(config);
const agentSvc = createAgentSvc(db, config, supervisor, larkBotRegistry);
const conv = createConversationFeature(db, config, supervisor, agentSvc, opsStore, tracer);

// Run service
const runSvc = createRunService({
  supervisor,
  eventLog,
  maxConcurrentRuns: config.maxConcurrentRuns,
  threads: new Set<string>(),
  idGen: ulid,
  autoTitle: {
    getThread: async (tid) => {
      const cid = parseThreadId(tid).conversationId || tid;
      const c = conv.convPort.getConversation(cid);
      if (c?.title) return { title: c.title };
      return c ? { title: null } : null;
    },
    getMessages: async (tid) =>
      (await conv.threadProjectionSvc.getMessages(tid)) as Message[] | null,
    setTitle: async (tid, title) => {
      const cid = parseThreadId(tid).conversationId || tid;
      conv.convPort.setConversationTitle(cid, title);
    },
    llm: { apiKey: config.anthropicApiKey },
  },
});

// ─── Event wiring ─────────────────────────────────────────────

supervisor.onRunComplete((threadId, runId, status, kind) =>
  onRunComplete(threadId, runId, status, conv.convPort, conv.convSvc, kind),
);

supervisor.onRunEvent((threadId, runId, event, kind) => {
  if (event.type === "todo_update") {
    const cid = [...conv.activeConversations].find((c) => threadId.startsWith(`${c}:`));
    if (!cid) return;
    const senderMemberId = parseThreadId(threadId).memberId || threadId;
    const acc = getOrCreateAccumulator(runId, senderMemberId);
    const payload = (event as { payload?: { todos?: unknown } }).payload;
    if (payload?.todos) acc.lastTodoUpdate = { todos: payload.todos };
    return;
  }

  if (event.type !== "message") return;
  const revision = event.payload;

  // Accumulate @mentions
  if (revision.role === "assistant") {
    const text =
      revision.text ??
      revision.blocks
        ?.filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join(" ") ??
      "";
    if (text) {
      const cid = [...conv.activeConversations].find((c) => threadId.startsWith(`${c}:`));
      if (cid) {
        const senderMemberId = parseThreadId(threadId).memberId || threadId;
        const acc = getOrCreateAccumulator(runId, senderMemberId);
        const roster = conv.convPort.getMembers(cid);
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

  const senderMemberId = parseThreadId(threadId).memberId || threadId;
  const acc = getOrCreateAccumulator(runId, senderMemberId);
  acc.projectionChain = acc.projectionChain
    .then(() =>
      projectRunMessageToLedger(
        threadId,
        runId,
        revision as MessageRevision,
        conv.activeConversations,
        conv.convPort,
        conv.convSvc,
        kind,
      ),
    )
    .catch((err) => {
      console.error(
        `[conversation] projectRunMessageToLedger failed for ${runId}:`,
        err instanceof Error ? err.message : String(err),
      );
    });
});

// ─── HTTP router ──────────────────────────────────────────────

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

// Lark-bot setup manager (lazy — created on first setup request)
let setupManager: LarkSetupManager | undefined;
function getSetupManager(): LarkSetupManager {
  if (!setupManager) {
    const provisioner = new CliSetupProvisioner();
    setupManager = new LarkSetupManager(provisioner, async (session) => {
      await agentSvc.update(session.agentId, {
        lark: { enabled: true, botDisplayName: session.botDisplayName ?? undefined },
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

// Ops service
const agentNames = new Map<string, string>();
{
  const rows = db.query("SELECT id, name FROM agents").all() as { id: string; name: string }[];
  for (const r of rows) agentNames.set(r.id, r.name);
}
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
    (id) => larkBotRegistry.statusOf(id),
    getSetupManager,
  ),
  runs: runRoutes(
    runSvc,
    (threadId, input, overrides) => buildAgentSpecV2(db, agentSvc, threadId, input, overrides),
    getThreadIdForRun,
  ),
  threadProjections: threadProjectionRoutes(conv.threadProjectionSvc),
  conversations: conversationRoutes(conv.convSvc, ulid),
  ops: opsRoutes(opsSvc),
});

// ─── Start ────────────────────────────────────────────────────

const server = createServer(config, router);
await supervisor.rediscover(eventLog);
server.start();
console.log(`[backend] listening on ${config.host}:${config.port}`);

// Launch lark-bots for enabled agents
(async () => {
  const allAgents = await agentSvc.list(true);
  for (const agent of allAgents) {
    if (agent.larkEnabled && agent.larkProfileRef) {
      larkBotRegistry
        .ensureLarkBot(agent.id, agent.larkBotDisplayName, agent.larkProfileRef)
        .catch((err) => console.error(`[lark] failed to start bot for ${agent.id}:`, err));
    }
  }
})();

// Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`[backend] ${signal} received, shutting down...`);
  server.stop();
  supervisor.cancelAll();
  await new Promise((r) => setTimeout(r, config.cancelGraceMs));
  await supervisor.dispose();
  await registry.dispose?.();
  await larkBotRegistry.dispose();
  setupManager?.dispose();
  db.close();
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
