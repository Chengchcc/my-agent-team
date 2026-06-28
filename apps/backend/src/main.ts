import { Database } from "bun:sqlite";
import {
  extractText,
  isTerminalMessageState,
  serializeMessageRevision,
} from "@my-agent-team/message";
import {
  createRuntimeTracer,
  resolveObservabilityConfig,
} from "@my-agent-team/runtime-observability";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createAgentSvc } from "./features/agent/agent-svc-factory.js";
import { createAgentIdentityStore } from "./features/agent/identity-store.js";
import { agentRoutes } from "./features/agent/index.js";
import {
  columnConfigRoutes,
  createColumnConfigService,
  sqliteColumnConfigAdapter,
} from "./features/column-config/index.js";
import { createConversationFeature } from "./features/conversation/conv-svc-factory.js";
import { conversationRoutes, parseSessionId } from "./features/conversation/index.js";
import {
  escapeRegExp,
  getOrCreateAccumulator,
  onRunComplete,
} from "./features/conversation/projection.js";
import {
  createCronJobService,
  createCronScheduler,
  cronJobRoutes,
  sqliteCronJobAdapter,
} from "./features/cron/index.js";
import {
  createDeliverableService,
  sqliteDeliverableAdapter,
} from "./features/deliverable/index.js";
import { createIssueService, issueRoutes, sqliteIssueAdapter } from "./features/issue/index.js";
import { CliSetupProvisioner, LarkSetupManager } from "./features/lark-bot/index.js";
import { createLarkBotRegistry } from "./features/lark-bot/lark-bot-registry-factory.js";
import { createOrchestrator } from "./features/orchestrator/index.js";
import {
  createProjectService,
  projectRoutes,
  sqliteProjectAdapter,
} from "./features/project/index.js";
import {
  createRuntimeOpsService,
  opsRoutes,
  RuntimeOpsStore,
} from "./features/runtime-ops/index.js";
import { resumeRoutes } from "./features/span/http.js";
import { createSessionFactory } from "./features/span/session-factory.js";
import { SpanSupervisor } from "./features/span/supervisor.js";
import * as backendSchema from "./infra/db/schema.js";
import { ulid } from "./infra/ids.js";
import { openDb } from "./infra/sqlite/db.js";
import { createServer } from "./server.js";

// ─── Bootstrap ─────────────────────────────────────────────────

const config = loadConfig();
const db = openDb(`${config.dataDir}/backend.db`);
// S1 storage convergence: events.db tables are now part of backend.db.
// The single db connection serves all backend-package-owned tables.

const obsConfig = resolveObservabilityConfig({ serviceName: "backend" });
const tracer = createRuntimeTracer(obsConfig);
const opsStore = new RuntimeOpsStore(db);

// Runner daemon removed — AgentSession runs in-process. Supervisor manages
// run/attempt rows without transport (NOOP_TRANSPORT is the internal default).

// Shared SessionFactory — all execution paths (conversation, cron, orchestrator)
// and the resume route share the same instance so sessions are visible across
// the process. Replaces the per-run session-registry.ts.
const sessionFactory = createSessionFactory({ config });

const supervisor = new SpanSupervisor({
  config,
  opsStore,
  tracer,
  db: db,
  onReap: (_runId, sessionId) => sessionFactory.dispose(sessionId),
});

// Feature services
const larkBotRegistry = createLarkBotRegistry(config);
const agentSvc = createAgentSvc(db, config, supervisor, larkBotRegistry);
const conv = createConversationFeature(
  db,
  config,
  supervisor,
  agentSvc,
  opsStore,
  undefined,
  sessionFactory,
);

// ─── Event wiring ─────────────────────────────────────────────

// P2: onRunComplete is AWAITED by supervisor — critical sink (ledger terminal write).
// P1: run_finalized already sent before this, so await doesn't block control signal.
supervisor.onRunComplete((sessionId, spanId, status, kind) => {
  // M19: issue-run isolation now handled by origin_kind in projection/reactor
  return onRunComplete(sessionId, spanId, status, conv.convPort, conv.convSvc, opsStore, kind);
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
supervisor.onRunMessage(async (sessionId, spanId, revision, kind) => {
  if (kind === "reflect") return;
  // M19: issue-run isolation now handled by origin_kind in projection
  const cid = parseSessionId(sessionId).conversationId;
  if (!cid) return;
  const senderMemberId = parseSessionId(sessionId).memberId || sessionId;

  // Write directly to ledger (authoritative entry for assistant messages)
  const seq = await conv.convSvc.appendAssistantMessage({
    conversationId: cid,
    senderMemberId,
    spanId,
    revision,
  });

  // Update accumulator for terminal processing (onRunComplete)
  const acc = getOrCreateAccumulator(spanId, senderMemberId);
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
    content: serializeMessageRevision({ ...revision, conversationId: cid, spanId }),
    ts: Date.now(),
  };
  void conv.convSvc
    .broadcastMessage(entry, { excludeMemberId: senderMemberId })
    .catch((err) =>
      console.error(
        `[main] broadcastMessage failed for ${spanId}:`,
        err instanceof Error ? err.message : String(err),
      ),
    );
});

// ─── HTTP router ──────────────────────────────────────────────

const identityStore = createAgentIdentityStore({
  dataDir: config.dataDir,
  getAgent: (id) => agentSvc.getById(id),
});

// Lark-bot setup manager (lazy — created on first setup request)
let setupManager: LarkSetupManager | undefined;
function getSetupManager(provisioner = new CliSetupProvisioner()): LarkSetupManager {
  if (!setupManager) {
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

// Ops service — read-only access to checkpoint_events (run-loop is the writer)
import { createCheckpointEventsStore } from "./features/runtime-ops/checkpoint-events-store.js";

const checkpointDb = new Database(`${config.dataDir}/checkpointer.db`, { readonly: true });
const checkpointEventsStore = createCheckpointEventsStore(checkpointDb);

const backendDrizzle = drizzle(db, { casing: "snake_case", schema: backendSchema });
const agentNames = new Map<string, string>();
{
  const rows = backendDrizzle
    .select({ id: backendSchema.agents.id, name: backendSchema.agents.name })
    .from(backendSchema.agents)
    .all();
  for (const r of rows) agentNames.set(r.id, r.name);
}
const opsSvc = createRuntimeOpsService({
  opsStore,
  supervisor,
  checkpointEventsStore,
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
  // M19 Fix 2: Create issue-side conversation on issue creation
  convPort: {
    createConversation: (input) => conv.convPort.createConversation(input),
    setConversationTitle: (id, title) => conv.convPort.setConversationTitle(id, title),
    addMember: (input) => conv.convPort.addMember(input),
  },
});

// M21: CronJob service
const cronSvc = createCronJobService({
  port: sqliteCronJobAdapter(db),
  idGen: ulid,
  agentExists: (id: string) => agentSvc.exists(id),
  convPort: {
    createConversation: (input) =>
      conv.convPort.createConversation({ ...input, createdAt: Date.now() }),
    addMember: (input) => conv.convPort.addMember({ ...input, joinedAt: Date.now() }),
  },
});

// M21: CronJob scheduler — register retry listener before orchestrator's onRunComplete
const cronScheduler = createCronScheduler({
  cronSvc,
  supervisor,
  opsStore,
  config,
  agentSvc,
  idGen: ulid,
  sessionFactory,
});

const orchestrator = createOrchestrator({
  config,
  issueSvc,
  agentSvc,
  supervisor,
  opsStore,
  idGen: ulid,
  columnConfigSvc,
  deliverableSvc,
  projectSvc: {
    getById: (id: string) => projectSvc.getById(id),
  },
  // M19 Fix 2: Lazy-add agent members to issue conversation before dispatch
  convPort: {
    addMember: (input) => conv.convPort.addMember(input),
  },
  sessionFactory,
});

// Register orchestrator's backfill listener (alongside conversation's onRunComplete)
supervisor.onRunComplete((sessionId, spanId, status, kind) =>
  orchestrator.onRunComplete(sessionId, spanId, status, kind),
);

// Resume route for ToolApprovalCard interrupt flow — uses AgentSession.resume()
// spanId → sessionId lookup via opsStore (run table); live session via SessionFactory.peek
const resumeRun = resumeRoutes({
  sessionFactory,
  getSessionIdByRunId: (spanId) => opsStore.getRuns([spanId])[0]?.sessionId ?? null,
});

const app = createApp(config.authToken, {
  resumeRun,
  agents: agentRoutes(
    agentSvc,
    identityStore,
    (id) => larkBotRegistry.statusOf(id),
    getSetupManager,
  ),
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
  cronJobs: cronJobRoutes(cronSvc, cronScheduler),
});

// ─── Start ────────────────────────────────────────────────────

const server = createServer(config, app);
// rediscover removed — AgentSession runs in-process, no daemon to reattach
server.start();
cronScheduler.start();
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
  // Stop cron timers/watchdogs before supervisor dispose, so a watchdog
  // or retry firing in the grace window can't touch a closed DB.
  cronScheduler.dispose();
  await supervisor.dispose();
  await larkBotRegistry.dispose();
  setupManager?.dispose();
  db.close();
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
