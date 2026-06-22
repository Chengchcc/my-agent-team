import { Database } from "bun:sqlite";
import type { Message } from "@my-agent-team/message";
import {
  deserializeLedgerContent,
  extractText,
  isTerminalMessageState,
  serializeMessageRevision,
} from "@my-agent-team/message";
import {
  createRuntimeTracer,
  resolveObservabilityConfig,
} from "@my-agent-team/runtime-observability";
import { loadConfig } from "./config.js";
import { createAgentSvc } from "./features/agent/agent-svc-factory.js";
import { createAgentIdentityStore } from "./features/agent/identity-store.js";
import { agentRoutes } from "./features/agent/index.js";
import {
  columnConfigRoutes,
  createColumnConfigService,
  sqliteColumnConfigAdapter,
} from "./features/column-config/index.js";
import {
  buildAgentSpecV2,
  createConversationFeature,
} from "./features/conversation/conv-svc-factory.js";
import { conversationRoutes, parseThreadId } from "./features/conversation/index.js";
import {
  escapeRegExp,
  getOrCreateAccumulator,
  onRunComplete,
} from "./features/conversation/projection.js";
import {
  createDeliverableService,
  sqliteDeliverableAdapter,
} from "./features/deliverable/index.js";
import { sqliteEventLog } from "./features/event-log/index.js";
import { createIssueService, issueRoutes, sqliteIssueAdapter } from "./features/issue/index.js";
import { CliSetupProvisioner, LarkSetupManager } from "./features/lark-bot/index.js";
import { createLarkBotRegistry } from "./features/lark-bot/lark-bot-registry-factory.js";
import { createOrchestrator } from "./features/orchestrator/index.js";
import {
  createProjectService,
  projectRoutes,
  sqliteProjectAdapter,
} from "./features/project/index.js";
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
  lock: conv.lock,
  idGen: ulid,
  autoTitle: {
    getThread: async (tid) => {
      const cid = parseThreadId(tid).conversationId || tid;
      const c = conv.convPort.getConversation(cid);
      if (c?.title) return { title: c.title };
      return c ? { title: null } : null;
    },
    getMessages: async (tid) => {
      // Read from ledger (M17.5 P7 canonical source), not thread projection
      const cid = parseThreadId(tid).conversationId || tid;
      const entries = conv.convPort.getLedgerEntries(cid);
      const folded = new Map<string, { role: "user" | "assistant"; text: string }>();
      for (const entry of entries) {
        if (entry.kind !== "message") continue;
        const parsed = deserializeLedgerContent(entry.content);
        if (!("messageId" in parsed)) continue;
        const role = entry.senderMemberId && !entry.senderMemberId.startsWith("human")
          ? "assistant" as const : "user" as const;
        if (parsed.text) {
          folded.set(parsed.messageId, { role, text: parsed.text });
        }
      }
      const msgs = [...folded.values()];
      return msgs.length > 0 ? msgs as Message[] : null;
    },
    setTitle: async (tid, title) => {
      const cid = parseThreadId(tid).conversationId || tid;
      conv.convPort.setConversationTitle(cid, title);
    },
    llm: { apiKey: config.anthropicApiKey },
  },
});

// ─── Event wiring ─────────────────────────────────────────────

// P2: onRunComplete is AWAITED by supervisor — critical sink (ledger terminal write).
// P1: run_finalized already sent before this, so await doesn't block control signal.
supervisor.onRunComplete((threadId, runId, status, kind) => {
  // M18.4 P2: skip issue threads in conversation projection.
  if (threadId.startsWith("issue:")) return;
  return onRunComplete(threadId, runId, status, conv.convPort, conv.convSvc, opsStore, kind);
});

// M17.5 P3: @mention regex cache — compile once per label, not per streaming revision.
const mentionRegexCache = new Map<string, RegExp>();
function getMentionRegex(label: string): RegExp {
  let re = mentionRegexCache.get(label);
  if (!re) {
    re = new RegExp(`@${escapeRegExp(label)}(?=\\s|[,.!?;:]|$)`, "g");
    mentionRegexCache.set(label, re);
  }
  return re;
}

// M17.5 P7: Authoritative ledger write for assistant messages — direct path,
// bypassing event_log. This replaces the old event_log → projection → ledger
// indirection. Message events are now written to ledger BEFORE EventLog, and
// EventLog only receives non-message execution events.
supervisor.onRunMessage(async (threadId, runId, revision, kind) => {
  if (kind === "reflect") return;
  // M18.4 P2: issue runs use threadId="issue:<id>" — skip conversation ledger.
  if (threadId.startsWith("issue:")) return;
  const cid = parseThreadId(threadId).conversationId;
  if (!cid) return;
  const senderMemberId = parseThreadId(threadId).memberId || threadId;

  // Write directly to ledger (authoritative entry for assistant messages)
  const seq = await conv.convSvc.appendAssistantMessage({
    conversationId: cid,
    senderMemberId,
    runId,
    revision,
  });

  // Update accumulator for terminal processing (onRunComplete)
  const acc = getOrCreateAccumulator(runId, senderMemberId);
  if (revision.role === "assistant") {
    acc.latestAssistantRevision = { ...revision, conversationId: cid };

    // @mention scanning (only on terminal revisions)
    if (isTerminalMessageState(revision.state)) {
      const text = extractText(revision);
      if (text) {
        const roster = conv.convPort.getMembers(cid);
        for (const m of roster) {
          if (m.kind !== "agent" || m.memberId === senderMemberId) continue;
          const label = m.displayName ?? m.memberId;
          const re = getMentionRegex(label);
          if (re.test(text) || text.includes(`@${m.memberId}`)) {
            acc.mentionedMemberIds.add(m.memberId);
          }
        }
      }
    }
  }

  // Fan-out to frontend subscribers (best-effort)
  const entry = {
    seq,
    conversationId: cid,
    senderMemberId,
    addressedTo: [] as string[],
    kind: "message" as const,
    content: serializeMessageRevision({ ...revision, conversationId: cid, runId }),
    ts: Date.now(),
  };
  void conv.convSvc
    .broadcastMessage(entry, { excludeMemberId: senderMemberId })
    .catch((err) =>
      console.error(
        `[main] broadcastMessage failed for ${runId}:`,
        err instanceof Error ? err.message : String(err),
      ),
    );
});

// M17.5 P7: onRunEvent is now best-effort observability only. Message events
// are handled by onRunMessage (authoritative ledger write). This callback only
// sees non-message events (todo_update, tool_start, tool_end, text_delta).
supervisor.onRunEvent((threadId, runId, event, _kind) => {
  // M18.4 P2: skip issue threads — no conversation context to accumulate.
  if (threadId.startsWith("issue:")) return;
  if (event.type === "todo_update") {
    const cid = parseThreadId(threadId).conversationId;
    if (!cid) return;
    const senderMemberId = parseThreadId(threadId).memberId || threadId;
    const acc = getOrCreateAccumulator(runId, senderMemberId);
    const payload = (event as { payload?: { todos?: unknown } }).payload;
    if (payload?.todos) acc.lastTodoUpdate = { todos: payload.todos };
    return;
  }
  // Non-message, non-todo events (tool_start, tool_end, etc.) — no-op.
  // Observability is handled by the EventLog append in supervisor.
});

// ─── HTTP router ──────────────────────────────────────────────

const getThreadIdForRun = async (runId: string) => {
  const row = eventsDb.query("SELECT thread_id FROM run WHERE run_id = ?").get(runId) as
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

// Project service (M18.3) — must be constructed before issueSvc so projectExists can be injected
const projectSvc = createProjectService({ port: sqliteProjectAdapter(db), idGen: ulid });

// ColumnConfig service (M18.4) — per-Project per-status execution config
const columnConfigSvc = createColumnConfigService({
  port: sqliteColumnConfigAdapter(db),
  idGen: ulid,
  agentExists: (id) => agentSvc.exists(id),
});

// Deliverable service (M18.5) — structured hand-off artifacts
const deliverableSvc = createDeliverableService({
  port: sqliteDeliverableAdapter(db),
  idGen: ulid,
});

// Issue service (M18.1) — projectExists hook wired for reference integrity (§3.2)
const issueSvc = createIssueService({
  port: sqliteIssueAdapter(db),
  idGen: ulid,
  projectExists: (id) => projectSvc.exists(id),
});

// M18.2 Orchestrator: build spec by agentId directly (not via member table)
const buildIssueSpec = async (agentId: string, threadId: string, input: string) => {
  const agent = await agentSvc.getById(agentId);
  return {
    schemaVersion: "2",
    agentId,
    threadId,
    runId: crypto.randomUUID(),
    mode: "run",
    input,
    model: {
      provider: agent.modelProvider,
      model: agent.modelName,
      ...(agent.modelBaseUrl ? { baseURL: agent.modelBaseUrl } : {}),
    },
    permissionMode: agent.permissionMode ?? "ask",
    maxSteps: agent.maxSteps ?? undefined,
  };
};

const orchestrator = createOrchestrator({
  issueSvc,
  agentSvc,
  supervisor,
  opsStore,
  buildSpec: buildIssueSpec,
  idGen: ulid,
  columnConfigSvc,
  deliverableSvc,
});

// Register orchestrator's backfill listener (alongside conversation's onRunComplete)
supervisor.onRunComplete((threadId, runId, status, kind) =>
  orchestrator.onRunComplete(threadId, runId, status, kind),
);

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
  issues: issueRoutes(issueSvc, opsStore, deliverableSvc, {
    onIssueStarted: (issue) => orchestrator.startStep(issue),
    onReviewRejected: async (issue) => {
      const started = await orchestrator.startStep(issue);
      if (!started) throw new Error(`rework step has no ColumnConfig for ${issue.status}`);
    },
  }),
  projects: projectRoutes(projectSvc),
  columnConfigs: columnConfigRoutes(columnConfigSvc),
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
