import { Database } from "bun:sqlite";
import { AnthropicChatModel } from "@my-agent-team/adapter-anthropic";
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
import { conversationRoutes } from "./features/conversation/index.js";
import { onRunComplete } from "./features/conversation/projection.js";
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
import {
  createSkillPackService as createSkillPackServiceFn,
  runInstall,
  runSync,
  seedSkillPacks,
  setSkillPackPort,
  skillPackRoutes,
  sqliteSkillPackAdapter,
} from "./features/skill-pack/index.js";
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
// Single database — all backend-package-owned tables live in one SQLite file.

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

// ─── Skill Pack Management (before agentSvc — onCreate depends on it) ──

const skillPackPort = sqliteSkillPackAdapter(db);
setSkillPackPort(skillPackPort);

await seedSkillPacks({
  port: skillPackPort,
  dataDir: config.dataDir,
  builtinSkillsDir: config.builtinSkillsDir,
});
const skillPackSvc = createSkillPackServiceFn({
  port: skillPackPort,
  idGen: ulid,
  triggerInstall: (packId, ctx) => {
    void runInstall(
      { packId, sourceKind: ctx.sourceKind, sourceUrl: ctx.sourceUrl, versionRef: ctx.versionRef },
      {
        model: new AnthropicChatModel({
          apiKey: config.anthropicApiKey,
          model: "claude-sonnet-4-6",
          baseUrl: config.anthropicBaseUrl,
        }),
        dataDir: config.dataDir,
        port: skillPackPort,
      },
    ).catch((err) => console.error(`[skill-pack] install failed for ${packId}:`, err));
  },
  triggerSync: (packId, ctx) => {
    void runSync(
      { packId, sourceKind: ctx.sourceKind, sourceUrl: ctx.sourceUrl, versionRef: ctx.versionRef },
      {
        model: new AnthropicChatModel({
          apiKey: config.anthropicApiKey,
          model: "claude-sonnet-4-6",
          baseUrl: config.anthropicBaseUrl,
        }),
        dataDir: config.dataDir,
        port: skillPackPort,
      },
    ).catch((err) => console.error(`[skill-pack] sync failed for ${packId}:`, err));
  },
});

// Feature services
const larkBotRegistry = createLarkBotRegistry(config);
const agentSvc = createAgentSvc(db, config, supervisor, larkBotRegistry, {
  onAgentCreate: (agentId) => skillPackSvc.setAgentPacks(agentId, ["builtin"]),
});
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
supervisor.onRunComplete((sessionId, spanId, status, kind, errorMessage) => {
  // M19: issue-run isolation now handled by origin_kind in projection/reactor
  return onRunComplete(
    sessionId,
    spanId,
    status,
    conv.convPort,
    conv.convSvc,
    opsStore,
    kind,
    errorMessage,
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

let checkpointEventsStore: ReturnType<typeof createCheckpointEventsStore>;
try {
  const checkpointDb = new Database(`${config.dataDir}/checkpointer.db`, { readonly: true });
  checkpointEventsStore = createCheckpointEventsStore(checkpointDb);
} catch (err) {
  if ((err as { code?: string }).code === "SQLITE_CANTOPEN") {
    const noop = () => [];
    checkpointEventsStore = {
      readBySpan: noop,
      readBySession: noop,
      readWindow: noop,
    };
    console.warn(
      `[bootstrap] checkpointer.db not found at ${config.dataDir} — ops fact-events will be empty until the first agent run`,
    );
  } else {
    throw err;
  }
}

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
    {
      listForAgent: (id: string) =>
        skillPackSvc
          .listForAgent(id)
          .then((rows) => rows.map((r) => ({ id: r.id, name: r.name, status: r.status }))),
      setAgentPacks: (id: string, packIds: string[]) => skillPackSvc.setAgentPacks(id, packIds),
    },
    identityStore,
    (id: string) => larkBotRegistry.statusOf(id),
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
  skillPacks: skillPackRoutes(skillPackSvc, config.dataDir),
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
