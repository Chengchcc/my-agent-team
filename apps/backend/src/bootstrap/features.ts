import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AskQuestionInput } from "@chengchenccc/message";
import { extractText, type Message, serializeMessageRevision } from "@chengchenccc/message";
import type { FeatureSet } from "../app.js";
import { createAgentSvc } from "../features/agent/agent-compose.js";
import { createAgentIdentityStore } from "../features/agent/agent-identity.js";
import { FRONT_DESK_DISABLED_TOOLS } from "../features/agent/front-desk-tools.js";
import {
  AgentBusyError,
  agentRoutes,
  createAgentConfigMcpServer,
} from "../features/agent/index.js";
import { FRONT_DESK_DISCIPLINE } from "../features/agent/prompt-front-desk.js";
import { writeMcpConfig, writeProductToolsManifest } from "../features/agent/workspace-bridge.js";
import {
  createAgentContextService,
  sqliteAgentContextAdapter,
} from "../features/agent-context/index.js";
import type { LedgerMessageResolver } from "../features/agent-context/ports.js";
import { AcpBackend } from "../features/agent-run/acp/acp-backend.js";
import { probeHarnessCatalog } from "../features/agent-run/acp/harness-catalog.js";
import { AcpModelCatalog } from "../features/agent-run/acp/model-catalog.js";
import { ACP_AGENTS } from "../features/agent-run/acp/registry.js";
import { answerRefusal } from "../features/agent-run/answer-guard.js";
import { deliveryNoteOf, producedByEvent } from "../features/agent-run/delivery-gate.js";
import { pendingActionId } from "../features/agent-run/domain.js";
import { finalAnswerMessage } from "../features/agent-run/execution-input.js";
import {
  agentRunRoutes,
  createAgentRunExecutionService,
  createAgentRunService,
  sqliteAgentRunAdapter,
} from "../features/agent-run/index.js";
import {
  deriveInterruptedJobs,
  type JobStateEvent,
  renderInterruptedJobs,
} from "../features/agent-run/interrupted-jobs.js";
import { createNotifyDispatcher } from "../features/agent-run/notify-dispatcher.js";
import type { BackendRegistry } from "../features/agent-run/protocol/index.js";
import type { RecallHit } from "../features/agent-run/recall.js";
import { requestOwnerOf } from "../features/agent-run/request-owner.js";
import {
  isIrreversibleRequest,
  isStatusQuestion,
} from "../features/agent-run/routing-observations.js";
import { endsWithQuestion, lastParagraph } from "../features/agent-run/unasked-question.js";
import {
  artifactRoutes,
  createArtifactFsAdapter,
  createArtifactService,
  createSqliteArtifactIndexAdapter,
} from "../features/artifact/index.js";
import { authRoutes, createPasswordService, MIN_PASSWORD_LENGTH } from "../features/auth/index.js";
import { codingRoutes } from "../features/coding/index.js";
import { createConversationFeature } from "../features/conversation/conversation-compose.js";
import {
  conversationRoutes,
  deriveConversationTitle,
  firstUserText,
  sqliteConversationAdapter,
} from "../features/conversation/index.js";
import { createConfiguredSummarizer } from "../features/conversation/summarize.js";
import { createMcpRuntimeStatusStore, mcpRoutes } from "../features/mcp/index.js";
import {
  applyServedAvailability,
  bareModelId,
  createHarnessCatalog,
  createOmaModelCatalog,
  createProviderModelProbe,
  createServedModelKnowledge,
  harnessRoutes,
  modelRoutes,
  providerOfModelId,
} from "../features/models/index.js";
import {
  createProductToolsDispatch,
  createProductToolsMcpServer,
  createProductToolsService,
  frameBrief,
  frameHandbackInput,
  frameReportInput,
  frameResultInput,
  sqliteProductToolCallAdapter,
} from "../features/product-tools/index.js";
import { createRunTokenRegistry } from "../features/product-tools/run-token-registry.js";
import { projectRoutes } from "../features/project/index.js";
import { pushProjectWorktree } from "../features/project/push.js";
import { createWorkspaceLockRegistry } from "../features/project/workspace-lock.js";
import {
  createProposalService,
  ProposalNotApplicable,
  type ProposalService,
  proposalRoutes,
  sqliteProposalAdapter,
} from "../features/proposal/index.js";
import { createProviderService, providerRoutes } from "../features/provider/index.js";
import { recall } from "../features/recall/recall.js";
import {
  createReminderService,
  REMINDER_BANNER_PREFIX,
  reminderRoutes,
  sqliteReminderAdapter,
} from "../features/reminder/index.js";
import {
  createRequirementService,
  requirementRoutes,
  sqliteRequirementAdapter,
} from "../features/requirement/index.js";
import { opsRoutes } from "../features/runtime-ops/index.js";
import { settingsRoutes } from "../features/settings/index.js";
import type { SkillPackRow } from "../features/skill-pack/index.js";
import {
  BUILTIN_PACK_ID,
  checkUpstream,
  createSkillPackService as createSkillPackServiceFn,
  installPath,
  resolveBuiltinSkillsDirForRole,
  runInstall,
  runSync,
  seedSkillPacks,
  setSkillPackPort,
  skillPackRoutes,
  sqliteSkillPackAdapter,
} from "../features/skill-pack/index.js";
import { createFsWikiStore, createWikiService, wikiRoutes } from "../features/wiki/index.js";
import {
  createWorkflowMcpServer,
  type WorkflowExecutionService,
} from "../features/workflow/index.js";
import { startAllowlistProxy } from "../infra/allowlist-proxy.js";
import { createEntityLabelResolver } from "../infra/entity-labels.js";
import { ulid } from "../infra/ids.js";
import { resolveOmaAcpArgv, resolveOmaCommand } from "../infra/oma-command.js";
import { createRetentionSweeper } from "../infra/retention.js";
import { sseUrlEndpoint } from "../infra/sse-url.js";
import type { BackendServices } from "./services.js";
import { wireAhp } from "./wiring-ahp.js";
import { wireCodingAndWorktrees } from "./wiring-coding.js";
import { wireOpsAndMcp } from "./wiring-ops-mcp.js";
import { seedDefaultTeamAndWorkflows } from "./wiring-seed.js";
import { wireWorkflows } from "./wiring-workflows.js";
import { wireWorkspaceAndRecall } from "./wiring-workspace.js";

// ─── Helper ───────────────────────────────────────────────────

/** Frozen system prompt from the Agent's editable identity files:
 *  SOUL.md as the identity, USER.md as the user context. */
export function buildAgentSystemPrompt(
  soul: string | null,
  user: string | null,
  /** ADR 0057: only agents that face humans get the routing discipline; a
   *  worker has nobody to route for. Absent role = legacy front. */
  opts?: { role?: "front" | "worker" | null },
): string | undefined {
  const parts: string[] = [];
  if (soul) parts.push(soul);
  if (user) parts.push(`User context:\n${user}`);
  if (opts?.role !== "worker") parts.push(FRONT_DESK_DISCIPLINE);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

// ─── Installer ────────────────────────────────────────────────

export interface InstalledFeatures {
  featureSet: FeatureSet;
  /** Phase 5 internal handles (not exposed via HTTP). */
  /** What an agent proposed and did not apply: the MCP tools write through it, the pages read. */
  proposalSvc: ProposalService;
  agentRunService: ReturnType<typeof createAgentRunService>;
  agentRunExecution: ReturnType<typeof createAgentRunExecutionService>;
  productTools: ReturnType<typeof createProductToolsService>;
  workflowExecutionService: WorkflowExecutionService;

  prepare(): Promise<void>;
  start(): Promise<void>;
  dispose(): Promise<void>;
}

export async function installFeatures(services: BackendServices): Promise<InstalledFeatures> {
  const { config, db, settingsSvc, mcpClientManager, larkBotRegistry } = services;
  const providerSvc = createProviderService(settingsSvc);

  // A change an agent proposes and a human adopts (ADR 0040): the MCP tools write these rows and
  // the target pages read them, so the proposal outlives the page that was open when it arrived.
  const proposalSvc = createProposalService({ port: sqliteProposalAdapter(db), idGen: ulid });

  // ─── Skill Pack (before agentSvc — onCreate depends on it) ──

  const skillPackPort = sqliteSkillPackAdapter(db);
  setSkillPackPort(skillPackPort);

  await seedSkillPacks({
    port: skillPackPort,
    dataDir: config.dataDir,
    builtinSkillsDir: config.builtinSkillsDir,
  });

  // Deterministic Skill Pack install/sync: no model, no Agent session.
  const skillPackSvc = createSkillPackServiceFn({
    port: skillPackPort,
    idGen: ulid,
    checkSync: async (packId, ctx) =>
      checkUpstream(
        {
          packId,
          sourceKind: ctx.sourceKind,
          sourceUrl: ctx.sourceUrl,
          versionRef: ctx.versionRef,
        },
        { dataDir: config.dataDir, port: skillPackPort },
      ),
    triggerInstall: (packId, ctx) => {
      void runInstall(
        {
          packId,
          sourceKind: ctx.sourceKind,
          sourceUrl: ctx.sourceUrl,
          versionRef: ctx.versionRef,
        },
        {
          dataDir: config.dataDir,
          port: skillPackPort,
          zipBuffer:
            ctx.zipBuffer ??
            (ctx.sourceKind === "zip" && ctx.sourceUrl
              ? Buffer.from(ctx.sourceUrl, "base64")
              : undefined),
        },
      ).catch((err: Error) => console.error(`[skill-pack] install failed for ${packId}:`, err));
    },
    triggerSync: (packId, ctx) => {
      void runSync(
        {
          packId,
          sourceKind: ctx.sourceKind,
          sourceUrl: ctx.sourceUrl,
          versionRef: ctx.versionRef,
          expectedRev: ctx.expectedRev,
        },
        {
          dataDir: config.dataDir,
          port: skillPackPort,
        },
      ).catch((err: Error) => console.error(`[skill-pack] sync failed for ${packId}:`, err));
    },
  });

  // ─── Agent service ──────────────────────────────────────────
  // Busy guard for hardDelete is wired after the Agent Run adapter exists.
  const busyGuard: { check: ((agentId: string) => void) | undefined } = { check: undefined };
  /** Shared per-worktree lock registry (A4): run dispatch, loop
   *  clean-start/reset and agent detach serialize on the same roots. */
  const workspaceLocks = createWorkspaceLockRegistry();
  /** #25: the ACP adapter reports the native session it bound, and the run row
   *  records it. Late-bound: the run port is built further down. */
  const onSessionBound: { fn: (runId: string, nativeRef: string) => void } = {
    fn: () => {},
  };

  // Workspace bridge (ADR 0003 decision 3): reconcile skills/mcp into the
  // agent workspace. Late-bound (mcpSvc is created further down).
  const reconcileAgent: {
    fn: (agentId: string, prevProjects?: string[]) => Promise<void>;
  } = { fn: async () => {} };
  const agentSvc = createAgentSvc(db, config, larkBotRegistry, {
    onAgentCreate: async (agentId: string) => {
      await skillPackSvc.setAgentPacks(agentId, ["builtin"]);
      await reconcileAgent.fn(agentId);
    },
    onAgentUpdate: async (agentId: string, prevProjects: string[]) => {
      await reconcileAgent.fn(agentId, prevProjects);
      // A running run keeps the config it was frozen with (by design). Saying so
      // on the run makes the divergence visible instead of silent — the audit's
      // "policy changed while in flight" (ADR 0080).
      const live = db
        .query(
          "SELECT run_id FROM agent_run WHERE agent_id = ? AND status IN ('running','waiting')",
        )
        .all(agentId) as Array<{ run_id: string }>;
      for (const row of live) {
        services.opsStore.appendRunEvent(row.run_id, "config_changed_during_run", { agentId });
      }
    },
    assertNoActiveRun: (agentId: string) => busyGuard.check?.(agentId),
    // Tests inject a no-op: the real writer edits the operator's live
    // `~/.lark-cli/config.json`, and a test suite must never do that.
    ...(services.larkProfileInit ? { profileInit: services.larkProfileInit } : {}),
  });

  // ─── Conversation + Phase 5 Agent Run (conversation first: the ledger
  //      resolver and run services build on its port; the execution service
  //      is wired last through dispatchRun to break the cascade cycle) ──

  const convPort = sqliteConversationAdapter(db);

  const ledgerResolver: LedgerMessageResolver = {
    async resolveMessage(conversationId, ledgerSeq) {
      const entry = convPort.getLedgerEntry(conversationId, ledgerSeq);
      if (entry?.kind !== "message") return null;
      // getLedgerEntry returns content already parsed (port type lies).
      return (entry.content as unknown as Message) ?? null;
    },
  };

  const contextPort = sqliteAgentContextAdapter(db, { ulid });
  const contextSvc = createAgentContextService({
    port: contextPort,
    idGen: { ulid },
    ledgerResolver,
  });
  const agentRunPort = sqliteAgentRunAdapter(db, {
    contextPort,
    ledgerResolver,
    idGen: { ulid },
    // ADR 0075: the owner of a parked request depends on whether the
    // dispatcher is a front desk or another worker.
    // Sync on purpose: pending actions are created inside a db.transaction.
    roleOfAgent: (agentId: string) => {
      const row = db.query("SELECT config FROM agents WHERE id = ?").get(agentId) as {
        config: string;
      } | null;
      if (row === null) return null;
      try {
        const cfg = JSON.parse(row.config) as { role?: "worker" | "front" };
        return cfg.role === "worker" ? "worker" : "front";
      } catch {
        return null;
      }
    },
  });

  // ADR 0074: tracked work items (requirements) — the stable goal the PA
  // identifies and maintains; runs link to it, the read model derives status.
  const requirementSvc = createRequirementService({
    port: sqliteRequirementAdapter(db),
    idGen: ulid,
  });

  // ADR 0074 S3: the wiki lives in its own data directory (a product-level
  // asset, not any agent's workspace) and is a git repository. Writes go
  // through the wiki_* product tools only.
  const wikiSvc = createWikiService({ store: createFsWikiStore(join(config.dataDir, "wiki")) });
  // #25: the ACP adapter reports every session bind here, so a run that dies
  // parked still owns the native session it was executing in.
  // #25: awaited by the ACP adapter BEFORE the prompt — a session whose
  // identity cannot be durably recorded must not execute.
  onSessionBound.fn = (runId, nativeRef) => agentRunPort.setRunNativeSessionRef(runId, nativeRef);
  busyGuard.check = (agentId: string) => {
    const row = db
      .query(
        `SELECT 1 FROM agent_run
         WHERE agent_id = ?
           AND status IN ('running','waiting','commit_failed') LIMIT 1`,
      )
      .get(agentId);
    if (row) throw new AgentBusyError(agentId);
  };
  // Agent identity (SOUL.md/USER.md) is read at Run creation and FROZEN into
  // the Run snapshot; dispatch never re-resolves it.
  const identityStore = createAgentIdentityStore({
    dataDir: config.dataDir,
    getAgent: (id: string) => agentSvc.getById(id),
  });
  const agentRunService = createAgentRunService({
    port: agentRunPort,
    contextService: contextSvc,
    idGen: { ulid },
    ledgerResolver,
    // Default frozen Run config: the target Agent's identity (SOUL.md +
    // USER.md) and its assigned READY skill packs. Loop scopes pass their
    // own LOOP.md config explicitly and skip this resolver.
    resolveRunConfig: async ({ conversationId, agentId }) => {
      if (!agentId) return {};
      const identity = await identityStore.getIdentity(agentId);
      const agentRow = await agentSvc.getById(agentId).catch(() => null);
      const systemPrompt = buildAgentSystemPrompt(identity.soul, identity.user, {
        role: agentRow?.config.role ?? null,
      });
      const agentRole = agentRow?.config.role === "worker" ? "worker" : "front";
      const builtinRoleDir = resolveBuiltinSkillsDirForRole(
        config.dataDir,
        config.builtinSkillsDir,
        agentRole,
      );
      const packs = await skillPackPort.listForAgent(agentId);
      const packRoots = packs
        .filter((p) => p.status === "ready")
        .map((p) =>
          p.id === BUILTIN_PACK_ID ? builtinRoleDir : installPath(config.dataDir, p.id),
        );
      // Role-scoped builtin skills are ALWAYS available - assigned packs add on top.
      const skillRoots = [builtinRoleDir, ...packRoots.filter((r) => r !== builtinRoleDir)];
      // ADR 0063 D2: what the LAST turn started and never finished. Derived
      // from telemetry (a started row with no end), never replayed - the
      // model decides whether re-running is safe.
      let interruptedBlock = "";
      try {
        const recent = await agentRunPort.listRecentRunsForConversations(
          [conversationId],
          7 * 24 * 60 * 60 * 1000,
        );
        const previous = recent
          .filter(
            (run) =>
              run.agentId === agentId &&
              run.terminalAt !== null &&
              (run.status === "completed" ||
                run.status === "failed" ||
                run.status === "aborted" ||
                run.status === "timeout"),
          )
          .sort((a, b) => (b.terminalAt ?? 0) - (a.terminalAt ?? 0))[0];
        if (previous) {
          const events = services.opsStore.listRunEvents(previous.runId, 500);
          interruptedBlock = renderInterruptedJobs(
            deriveInterruptedJobs(events as unknown as JobStateEvent[]),
          );
        }
      } catch {
        /* a missing history never blocks a run */
      }
      const basePrompt = systemPrompt ?? "";
      const withInterrupted = interruptedBlock
        ? basePrompt
          ? `${basePrompt}\n\n${interruptedBlock}`
          : interruptedBlock
        : basePrompt;
      // ADR 0076 H4, the fourth read point: the room's project is told to the
      // front desk itself. The guard, the brief and the terminal already read
      // it; the model did not, and asked "which project is this README in?"
      // of a room bound to one (live 2026-11-24) — the most common unnecessary
      // question on a vague request.
      const roomProjectId = conv.convPort.getConversation(conversationId)?.projectId ?? null;
      const roomProject = roomProjectId === null ? null : projectSvc.getById(roomProjectId);
      const roomLine =
        roomProject === null
          ? ""
          : `\n\nThis room is about the project "${roomProject.name}". A request here is about that project unless the person says otherwise — do not ask which project.`;
      const withRoom = `${withInterrupted}${roomLine}`.trim();
      const result: {
        systemPrompt?: string;
        skillRoots?: readonly string[];
        permissionMode?: string;
        toolPolicy?: { deny: string[]; allow: string[]; denyCommands?: string[] };
      } = {};
      if (withRoom) result.systemPrompt = withRoom;
      if (skillRoots.length > 0) result.skillRoots = skillRoots;
      const agent = agentRow;
      if (agent) result.permissionMode = agent.config.runtime_config.permission_mode;
      if (agent) {
        const rc = agent.config.runtime_config;
        // ADR 0072: the FRONT DESK routes; it does not edit code or shell out.
        // Its own workspace is not the place the work happens, so handing it
        // bash/write/edit only lets it bypass dispatch (live: it edited the
        // worker's files and reported "已加好"). Workers keep every tool.
        // ADR 0072/0074: the boundary lives in one list so the prompt and the
        // tool filter cannot drift (the prompt says "you have no repository";
        // the list is what makes that true).
        const frontDeskTools = agent.config.role === "worker" ? [] : [...FRONT_DESK_DISABLED_TOOLS];
        if (
          rc.deny_write_paths.length > 0 ||
          rc.allow_write_paths.length > 0 ||
          rc.deny_commands.length > 0 ||
          frontDeskTools.length > 0
        ) {
          result.toolPolicy = {
            deny: [...rc.deny_write_paths],
            allow: [...rc.allow_write_paths],
            denyCommands: [...rc.deny_commands],
            ...(frontDeskTools.length > 0 ? { disabledTools: frontDeskTools } : {}),
          };
        }
      }
      return result;
    },
    resolveAgentEnabled: async ({ agentId }) => {
      if (!agentId) return true; // loop synthetic scope (no agent row)
      const agent = await agentSvc.getById(agentId).catch(() => null);
      return agent?.config.enabled ?? true;
    },
  });
  const dispatchRun: { fn: (runId: string) => Promise<void> } = { fn: async () => {} };
  const injectSteer: {
    fn: (
      branchId: string,
      input: { inputId: string; message: Message },
      opts?: { keepIfIdle?: boolean },
    ) => Promise<void>;
  } = { fn: async () => {} };
  const isLive: { fn: (runId: string) => boolean } = { fn: () => false };
  const isInflight: { fn: (runId: string) => boolean } = { fn: () => false };
  const abortStaleRun: { fn: (runId: string) => Promise<void> } = { fn: async () => {} };
  // The continuity record exists FOR surfaces ("this conversation moved"), so the chat channels
  // are told when one lands. Filled in once the AHP host exists, like the holders above.
  const onContinuityRecorded: {
    fn: (input: { conversationId: string; controlSeq: number }) => void;
  } = { fn: () => {} };
  // An undo removes rows the action stream cannot state (nothing dispatches "a message is gone"),
  // so the chat channels are told to truncate. Filled in once the AHP host exists.
  const onMessagesUndone: { fn: (input: { conversationId: string }) => void } = { fn: () => {} };
  // The backend's only model call: /compact folds the older entries into one
  // summary. Not configured => compaction keeps answering 501 (never a silent
  // no-op); malformed => the boot fails here, loudly.
  const summarizeFromConfig = createConfiguredSummarizer(config.summaryModel, (id) =>
    providerSvc.credentialFor(id),
  );
  /** The enabled, non-archived roster as capability cards — read by team_list. */
  const rosterCards = async () => {
    const rows = await agentSvc.list();
    return rows
      .filter((row) => row.archivedAt === null && row.config.enabled)
      .map((row) => ({
        id: row.id,
        name: row.config.name,
        description: row.config.description,
        skills: row.config.skills.map((s) =>
          s.description.length > 0 ? `${s.id}：${s.description}` : s.id,
        ),
        ...(row.config.runtime_config.projects.length > 0
          ? {
              projects: row.config.runtime_config.projects.map((pid) => {
                const project = projectSvc.getById(pid) as { name?: string } | null;
                return { projectId: pid, name: project?.name ?? pid };
              }),
            }
          : {}),
      }));
  };
  const conv = createConversationFeature({
    convPort,

    agentSvc,
    agentRunService,
    // ADR 0080: freeze a real config revision on the run — the member's config
    // `updatedAt`, which moves whenever its settings change. A constant 1 made
    // "which policy was this authorised under" unanswerable.
    configRevisionOf: async (id: string) => {
      try {
        return (await agentSvc.getById(id)).updatedAt;
      } catch {
        return 1;
      }
    },
    summarize: summarizeFromConfig,
    resolveLedgerMessage: (conversationId, ledgerSeq) =>
      ledgerResolver.resolveMessage(conversationId, ledgerSeq),
    dispatchRun: (runId: string) => dispatchRun.fn(runId),
    injectSteer: (branchId, input, opts) => injectSteer.fn(branchId, input, opts),
    isLive: (runId: string) => isLive.fn(runId),
    isInflight: (runId: string) => isInflight.fn(runId),
    abortStaleRun: (runId: string) => abortStaleRun.fn(runId),
    onContinuityRecorded: (input) => onContinuityRecorded.fn(input),
    onMessagesUndone: (input) => onMessagesUndone.fn(input),
    contextService: contextSvc,
    // Roadmap (自由文本追问): the productTools binding is declared below —
    // the closure dereferences it at request time, long after boot wiring.
    answerPendingTextAsk: async (conversationId, text) => {
      const ask = await productTools.pendingTextAskForConversation(conversationId);
      if (!ask) {
        // ADR 0074 S2: nothing pending — if an ask here was answered recently,
        // this reply probably belonged to it. Observation only (the matching
        // gap is measured, not silently "fixed" by guessing).
        void productTools.observeOrphanTextAnswer(conversationId);
        return false;
      }
      return await productTools.resolveAskDurable(ask.runId, ask.callId, {
        answers: [{ id: ask.questionId, selectedValues: [], freeText: text }],
      });
    },
  });

  // ADR 0082 D5: shared batch label resolver (agents, conversations, requirements, projects, workflows).
  const entityLabels = createEntityLabelResolver(db, {
    workflowDir: join(config.dataDir, "workflows"),
  });

  // Artifact storage (shared across agents, workspaces, workflows).
  // ADR 0082 D1: bytes stay on disk; SQLite indexes metadata + cross-entity provenance.
  const artifactService = createArtifactService(
    createSqliteArtifactIndexAdapter({
      inner: createArtifactFsAdapter(join(config.dataDir, "artifacts")),
      db,
      labelResolver: entityLabels,
    }),
  );
  void artifactService.backfill().catch((err: unknown) => {
    console.error("[artifacts] index backfill failed:", err instanceof Error ? err.message : err);
  });

  // Product Tools (History) - assembled unconditionally so the MCP endpoint
  // and the execution manifest are consistent; the MCP server only listens
  // when a URL is configured.
  // ask_question routes a run-scoped ask_requested event onto the run's live
  // SSE stream (backend.oma.* extension event) so the web can surface the
  // AskQuestionCard. agentRunExecution is created later, so resolve lazily via
  // a mutable holder assigned after it exists.
  // ADR 0055: the recall computed for each live run, so `dispatch` can offer
  // evidence for missing slots instead of letting the model re-ask. Bounded:
  // a run's recall is only useful while the run lives.
  const recallByRun = new Map<string, readonly RecallHit[]>();
  let broadcastAskEvent:
    | ((input: { runId: string; callId: string; question: AskQuestionInput }) => void)
    | null = null;
  // Same holder for the plan strip: todo_write is executed by this service, so
  // the native tool's todo_update hook is not in play and nothing else could
  // publish the event both surfaces render from.
  let broadcastTodoEvent: ((input: { runId: string; items: readonly unknown[] }) => void) | null =
    null;
  // Reminder service must exist before product tools: remind_me /
  // reminder_list / reminder_cancel call it at request time. Delivery routes
  // to the author (ADR 0041) — an unaddressed room delivery would never wake.
  const reminderSvc = createReminderService({
    port: sqliteReminderAdapter(db),
    idGen: ulid,
    deliver: async ({ conversationId, text }) => {
      await conv.convSvc.postMessage({
        conversationId,
        content: `${REMINDER_BANNER_PREFIX}${text}`,
        mode: "normal",
        // ADR 0047: no human authored this run — the reminder tick did.
        authorization: "system",
      });
    },
  });

  // ADR 0059 D5: one closure for everything that travels from a dispatched
  // run back to its dispatcher (terminal state + `report`). Rails, depth
  // guard and the progress-never-wakes rule live in the module; this is only
  // the port wiring.
  const notifyDispatcher = createNotifyDispatcher({
    getRun: (runId) => agentRunPort.getRun(runId),
    getActiveRun: (branchId) => agentRunPort.getActiveRun(branchId),
    // ADR 0060 D3: at the chain-depth limit the notice goes to the agent the
    // human talks to, never to the worker chain that hit the limit.
    getFrontDeskAgent: async (conversationId) =>
      conv.convPort.getConversation(conversationId)?.agentId ?? null,
    enqueueSteer: async (input) => {
      // `expectedRevision` is the BRANCH's CAS counter, not the config
      // revision. Passing configRevision (constant 1) made the CAS fail on
      // every later turn, so a live steer always fell through to the inject
      // fallback — the message arrived, but the queue row and the run
      // disagreed about it. Read the branch this steer targets.
      const steerBranch = await contextPort.getBranch(input.branchId).catch(() => null);
      const res = await agentRunPort.enqueueAndAcquire({
        conversationId: input.conversationId,
        agentId: input.agentId,
        branchId: input.branchId,
        mode: "steer",
        message: input.message,
        inputIdempotencyKey: input.idempotencyKey,
        runIdempotencyKey: input.idempotencyKey,
        deliveryIdempotencyKey: input.idempotencyKey,
        defaultModel: input.defaultModel,
        configRevision: input.configRevision,
        expectedRevision: steerBranch?.revision ?? input.configRevision,
        authorization: input.authorization,
        parentRunId: input.parentRunId,
      });
      return { inputId: res.inputId, queued: res.queued, acquired: res.acquired };
    },
    injectSteer: (branchId, input, opts) => injectSteer.fn(branchId, input, opts),
    postMessage: (input) =>
      conv.convSvc.postMessage({
        conversationId: input.conversationId,
        senderMemberId: input.senderMemberId,
        trigger: input.trigger,
        content: input.content,
        authorization: input.authorization,
        parentRunId: input.parentRunId,
      }),
    // ADR 0060 D6: the mark is what recovery sweeps on; without it a lost
    // notice is invisible forever.
    markNotified: (runId) => agentRunPort.markResultNotified(runId),
  });

  /** The dispatcher's plan as the worker's result will carry it. The plan is
   *  the todo snapshot of the dispatcher's most recent run — the only place a
   *  multi-step intention survives a turn boundary. */
  const planOfDispatcher = (dispatcherConversationId: string | null): string => {
    if (dispatcherConversationId === null) return "";
    const row = db
      .query(
        `SELECT todo_snapshot FROM agent_run
          WHERE conversation_id = ? AND todo_snapshot IS NOT NULL AND todo_snapshot <> ''
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(dispatcherConversationId) as { todo_snapshot: string } | null;
    if (row === null) return "";
    try {
      const parsed: unknown = JSON.parse(row.todo_snapshot);
      if (!Array.isArray(parsed)) return "";
      const lines: string[] = [];
      for (const item of parsed) {
        if (typeof item !== "object" || item === null) continue;
        const text = "text" in item && typeof item.text === "string" ? item.text : "";
        const status = "status" in item && typeof item.status === "string" ? item.status : "";
        if (text !== "") lines.push(`- [${status || "pending"}] ${text}`);
      }
      return lines.join("\n");
    } catch {
      return "";
    }
  };

  /** Artifact URLs a run uploaded. Read from the product-tool ledger: the
   *  upload result is the only place the URL is recorded, and a chain that
   *  hands the next step a paraphrase instead of the URL loses the deliverable
   *  (live 2026-11-22: the research report existed only as chat text). */
  const artifactUrlsOf = (runId: string): string[] => {
    const rows = db
      .query(
        "SELECT result FROM product_tool_call WHERE run_id = ? AND tool_name = 'artifact_upload'",
      )
      .all(runId) as Array<{ result: string | null }>;
    const urls: string[] = [];
    for (const row of rows) {
      if (row.result === null) continue;
      try {
        const parsed: unknown = JSON.parse(row.result);
        if (typeof parsed === "object" && parsed !== null && "url" in parsed) {
          const url = parsed.url;
          if (typeof url === "string" && url.startsWith("artifacts://")) urls.push(url);
        }
      } catch {
        /* a malformed row is skipped, never fatal */
      }
    }
    return urls;
  };

  /** ADR 0075: a parked request goes to its owner.
   *
   *  - dispatched work: wake the dispatcher IN ITS OWN ROOM with the request
   *    details, so it can answer (answer_worker_request) or escalate;
   *  - anything the human owns: if the run lives in a child room, write a
   *    notice into the parent room — that is the chat Lark is bound to. Worker
   *    rooms have no binding, which is exactly why approvals were invisible.
   */
  async function surfaceRequest(input: {
    runId: string;
    callId: string;
    kind: string;
    payload: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    const run = await agentRunPort.getRun(input.runId).catch(() => null);
    if (run === null) return;
    const room = conv.convPort.getConversation(run.conversationId);
    if (!room) return;
    const roleOf = (agentId: string): "worker" | "front" | null => {
      const row = db.query("SELECT config FROM agents WHERE id = ?").get(agentId) as {
        config: string;
      } | null;
      if (row === null) return null;
      try {
        const cfg = JSON.parse(row.config) as { role?: "worker" | "front" };
        return cfg.role === "worker" ? "worker" : "front";
      } catch {
        return null;
      }
    };
    const owner = requestOwnerOf({ authorization: run.authorization ?? null, roleOf });
    const worker =
      run.agentId === null ? null : await agentSvc.getById(run.agentId).catch(() => null);
    const workerName = worker?.config.name ?? run.agentId ?? "worker";
    const detail =
      input.kind === "approval"
        ? `审批：${String(input.payload.toolName ?? "动作")} — ${String(input.payload.reason ?? "").slice(0, 200)}`
        : `提问：${String((input.payload.questions as Array<{ question?: string }> | undefined)?.[0]?.question ?? "").slice(0, 200)}`;

    if (owner.agentId === null) {
      // Human-owned. A root room already reaches the inbox (and the Lark card
      // renders the pending action). A child room does NOT: the bot delivers
      // run turns only, so a plain notice row is invisible there (checked in
      // the bot's delivery ledger, 2026-11-21). The path that works is the
      // front desk: wake the parent room's agent and have it escalate with a
      // structured ask, which IS a card.
      const parentId = room.parentConversationId;
      if (!parentId) return;
      const frontDesk = conv.convPort.getConversation(parentId)?.agentId ?? null;
      if (frontDesk === null) return;
      await conv.convSvc.postMessage({
        conversationId: parentId,
        senderMemberId: run.agentId ?? "system",
        content: [
          `【需要人类决定】${workerName} 在子会话「${room.title ?? "未命名"}」停下了：${detail}`,
          "用 ask_question 在本房间升级给人：写清谁在问、在做什么、要执行什么、为什么必须由人决定、影响范围，并给出允许/拒绝选项。",
        ].join("\n"),
      });
      return;
    }

    const target = room.parentConversationId ?? room.conversationId;
    await conv.convSvc.postMessage({
      conversationId: target,
      senderMemberId: run.agentId ?? "system",
      content: [
        `【请求】${workerName} 需要你决定：${detail}`,
        `用 answer_worker_request(run_id="${run.runId}", call_id="${input.callId}", evidence=[...]) 回答；`,
        "答不了（不可逆操作 / 超出授权 / 验收 / 无证据）就升级给人。",
      ].join("\n"),
    });
  }

  const productTools = createProductToolsService({
    runPort: agentRunPort,
    // ADR 0080: the dispatcher's risk rides the worker's run.
    setRunRisk: (runId, risk) => agentRunPort.setRunRisk?.(runId, risk),
    contextPort,
    conversationPort: convPort,
    callPort: sqliteProductToolCallAdapter(db),
    idGen: { ulid },
    artifactService,
    reminder: {
      create: (input) =>
        reminderSvc.create({
          conversationId: input.conversationId,
          createdBy: input.createdBy,
          text: input.text,
          fireAt: input.fireAt,
          ...(input.recurrence ? { recurrence: input.recurrence } : {}),
        }),
      listByAgent: (agentId) => reminderSvc.listByAgent(agentId),
      cancel: (id) => reminderSvc.cancelReminder(id),
    },
    onAskAnswered: (input) => {
      void chatWriter
        .announceHumanInput({ ...input, outcome: "answered" })
        .catch((err) =>
          console.error(`[bootstrap] ask announcement failed for ${input.runId}:`, err),
        );
    },
    recallForRun: (runId) => recallByRun.get(runId) ?? [],
    // ADR 0074 S2: observations (text-answer mismatch) go to the ops log —
    // recorded, never acted on.
    observe: (runId, kind, payload) => services.opsStore.appendRunEvent(runId, kind, payload),
    // ADR 0074: tracked work items — the PA's requirement tools, plus the
    // dispatch link (named id → the conversation's newest open item → one
    // created from the brief). All resolution lives in the requirement
    // service; this closure only connects ports.
    // ADR 0075: the dispatcher answers a worker's parked request. Ownership is
    // enforced here (the row says who should answer), and the audit stamp is
    // written by the same call. Late-bound: agentRunExecution and productTools
    // are assembled below.
    answerWorkerRequest: async ({ agentId, runId, callId, decision, answer, evidence }) => {
      const actionId = pendingActionId(runId, callId);
      const action = await agentRunPort.getPendingAction(actionId);
      if (action === null) {
        return { ok: false as const, error: `request ${callId} is no longer pending` };
      }
      // One rule, shared with the tool's shape checks (see answer-guard).
      const refusal = answerRefusal(
        {
          actionId: callId,
          status: action.status,
          owner: action.owner ?? null,
          payload: action.payload,
        },
        agentId,
      );
      if (refusal !== undefined) return { ok: false as const, error: refusal };
      if (action.kind === "approval") {
        if (decision === undefined) {
          return { ok: false as const, error: "an approval needs decision: allow | deny" };
        }
        await agentRunExecution.resolveApproval(runId, callId, decision);
      } else {
        if (answer === undefined) {
          return { ok: false as const, error: "an ask needs answer" };
        }
        const woke = await productTools.resolveAskDurable(
          runId,
          callId,
          answer as Parameters<typeof productTools.resolveAsk>[2],
        );
        if (!woke) {
          return { ok: false as const, error: `ask ${callId} is not pending or already resolved` };
        }
      }
      await agentRunPort.markActionAnswered?.(actionId, `agent:${agentId}`, evidence);
      return { ok: true as const };
    },
    onRequestCreated: (input) => {
      void surfaceRequest(input).catch(async (err: unknown) => {
        console.error(
          `[bootstrap] request notice failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        // The machine route (the owner agent) could not be told, so it will
        // never answer: hand the question to the person instead of leaving an
        // orphan in the inbox that reads as "the agent is on it".
        await agentRunPort
          .escalateActionToUser?.(pendingActionId(input.runId, input.callId))
          .catch(() => undefined);
      });
    },
    // ADR 0076: hand the change back. Credential from the backend's env only;
    // the branch is derived from the run id inside pushProjectWorktree.
    pushProject: async ({ agentId, runId, project, message, note }) => {
      const agent = await agentSvc.getById(agentId).catch(() => null);
      if (agent === null) return { ok: false as const, error: `agent not found: ${agentId}` };
      const named = projectSvc
        .list()
        .find((candidate) => candidate.projectId === project || candidate.name === project);
      if (named === undefined) return { ok: false as const, error: `unknown project: ${project}` };
      if (!agent.config.runtime_config.projects.includes(named.projectId)) {
        return { ok: false as const, error: `${agentId} is not bound to ${named.name}` };
      }
      if (named.repoUrl === null || named.repoUrl === "") {
        return { ok: false as const, error: `project ${named.name} has no remote to push to` };
      }
      // ADR 0077: what gets pushed is the requirement's checkout OF THAT PROJECT.
      // The run's workspace is, by construction, its room's current requirement's
      // checkout (execution resolves it from the same pointer), so the question
      // is only whether THIS room's requirement has an open checkout of THIS
      // project: a run in A's checkout cannot push to B's remote, and an agent
      // workspace (SOUL.md, .mcp.json) is never handed back as a project.
      // (Measured: `run.workspace` is not persisted on the run row — it is
      // resolved at delivery — so reading it here always saw "unset".)
      const run = await agentRunPort.getRun(runId).catch(() => null);
      const room = checkoutOf(run?.conversationId ?? "");
      const checkout =
        room.requirementId === null
          ? null
          : workspaceSvc.findForRequirement({
              requirementId: room.requirementId,
              projectId: named.projectId,
            });
      if (checkout === null) {
        return {
          ok: false as const,
          error:
            `this run's room has no ${named.name} checkout to hand back ` +
            "(its requirement was never given one for that project); " +
            "dispatch work on that project here first",
        };
      }
      const checkoutPath = checkout.path;
      try {
        const pushed = pushProjectWorktree({
          worktree: checkoutPath,
          repoUrl: named.repoUrl,
          runId,
          message,
          ...(note !== undefined ? { note } : {}),
          ...(config.projectPushToken !== undefined ? { token: config.projectPushToken } : {}),
          ...(named.defaultBranch !== null ? { defaultBranch: named.defaultBranch } : {}),
          ...(agent.config.name ? { agent: agent.config.name } : {}),
        });
        // The delivery's fixed revision, as a fact (not as prose the model may
        // paraphrase): a person reviewing later reads the branch and the
        // provider's base...branch comparison for THIS run (audit 2026-11-24).
        services.opsStore.appendRunEvent(runId, "project_delivered", {
          projectId: named.projectId,
          branch: pushed.branch,
          commits: pushed.commits,
          compareUrl: pushed.compareUrl,
        });
        return { ok: true as const, ...pushed };
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    // ADR 0076: the room's project and each member's holdings, for the
    // dispatch guard (a topic room needs a worker with a copy of it).
    roomProjectOf: (conversationId) => {
      const projectId = conv.convPort.getConversation(conversationId)?.projectId ?? null;
      if (projectId === null) return null;
      const project = projectSvc.getById(projectId);
      return { projectId, name: project.name };
    },
    workerProjects: (agentId) => {
      const row = db.query("SELECT config FROM agents WHERE id = ?").get(agentId) as {
        config: string;
      } | null;
      if (row === null) return [];
      try {
        const cfg = JSON.parse(row.config) as { runtime_config?: { projects?: string[] } };
        return cfg.runtime_config?.projects ?? [];
      } catch {
        return [];
      }
    },
    // ADR 0076: propose a project (name + repo + who holds it). The proposal
    // service records it; a human adopts it in Web. Nothing is registered here.
    proposeProject: (input) => {
      const proposal = proposalSvc.propose("project_creation", input.name, {
        name: input.name,
        repoUrl: input.repoUrl,
        ...(input.defaultBranch !== undefined ? { defaultBranch: input.defaultBranch } : {}),
        ...(input.attachTo !== undefined ? { attachTo: [...input.attachTo] } : {}),
        proposedBy: input.proposedBy,
      });
      return { proposalId: proposal.id };
    },
    // A change to a registered project, recorded against the project's id. The project form
    // shows it beside its fields; adopting it there is what applies it.
    proposeProjectUpdate: (input) => {
      const proposal = proposalSvc.propose("project_update", input.projectId, {
        projectId: input.projectId,
        ...input.changes,
        proposedBy: input.proposedBy,
      });
      return { proposalId: proposal.id };
    },
    // ADR 0074: project registry, dereferenced at request time (projectSvc is
    // assembled later in this function, like the other late bindings here).
    projects: {
      list: () =>
        projectSvc.list().map((p) => ({
          projectId: p.projectId,
          name: p.name,
          repoUrl: p.repoUrl ?? null,
        })),
      // ADR 0080: the PA manages projects through MCP; it needs to see who
      // holds a project before attaching anyone.
      detail: async (ref) => {
        const p = projectSvc.list().find((x) => x.projectId === ref || x.name === ref);
        if (p === undefined) return null;
        const roster = await agentSvc.list();
        const agents = roster
          .filter((a) => a.config.runtime_config.projects.includes(p.projectId))
          .map((a) => ({
            id: a.id,
            name: a.config.name,
            role: a.config.role ?? null,
          }));
        return {
          projectId: p.projectId,
          name: p.name,
          repoUrl: p.repoUrl ?? null,
          defaultBranch: p.defaultBranch ?? null,
          agents,
        };
      },
      attach: async ({ project, agentId, attached }) => {
        const p = projectSvc.list().find((x) => x.projectId === project || x.name === project);
        if (p === undefined) return { ok: false as const, error: `unknown project: ${project}` };
        const agent = await agentSvc.getById(agentId).catch(() => null);
        if (agent === null) return { ok: false as const, error: `unknown member: ${agentId}` };
        const current = agent.config.runtime_config.projects;
        const next = attached
          ? [...new Set([...current, p.projectId])]
          : current.filter((id) => id !== p.projectId);
        if (next.length !== current.length) {
          await agentSvc.update(agentId, { projects: next });
        }
        const rows = await agentSvc.list();
        return {
          ok: true as const,
          agents: rows
            .filter((a) => a.config.runtime_config.projects.includes(p.projectId))
            .map((a) => ({ id: a.id, name: a.config.name })),
        };
      },
    },
    // ADR 0074 S4: what the team already knows rides in the brief.
    wikiRecall: (text) =>
      wikiSvc
        .query({ text, limit: 3, excludeSections: ["personal"] })
        .map((h) => ({ path: h.path, title: h.title })),
    wiki: {
      read: (path) => wikiSvc.read(path),
      query: (input) => wikiSvc.query(input),
      lint: () => wikiSvc.lint(),
      create: (input) => wikiSvc.create(input),
      patch: (input) => wikiSvc.patch(input),
      addSource: (input) => wikiSvc.addSource(input),
    },
    requirements: {
      create: (input) => requirementSvc.create(input),
      update: (id, patch) => requirementSvc.update(id, patch),
      get: (id) => requirementSvc.get(id),
      list: (includeClosed) => requirementSvc.list(includeClosed),
      linkDispatchedRun: (input) => {
        // One truth for "which requirement" (ADR 0077): the brief's named one,
        // else the room's current one. "The conversation's newest open item" —
        // the 0074 fallback — stays for rooms that never got a pointer.
        const pointed = workspaceSvc.currentRequirementOf(input.conversationId);
        const item = requirementSvc.resolveForDispatch({
          ...(input.requirementId !== undefined
            ? { requirementId: input.requirementId }
            : pointed !== null
              ? { requirementId: pointed }
              : {}),
          conversationId: input.conversationId,
          agentId: input.agentId,
          briefTitle: input.briefTitle,
          briefGoal: input.briefGoal,
          ...(input.acceptance !== undefined && input.acceptance !== null
            ? { acceptance: input.acceptance }
            : {}),
        });
        agentRunPort.setRequirementId?.(input.runId, item.requirementId);
        return { requirementId: item.requirementId };
      },
    },
    emitAsk: (input) => broadcastAskEvent?.(input),
    emitTodo: (input) => broadcastTodoEvent?.(input),
    // HITL over chat: hours, not minutes (user decision 2026-09-25).
    askTimeoutMs: config.askTimeoutMs,
    // ADR 0038: an answered ask whose run lost its live child (restart
    // while parked) resume-dispatches. Late-bound: the execution service is
    // assembled after this point, and ask resolves only happen at runtime.
    onRunWoke: (runId) => {
      void agentRunExecution?.resumeParkedRun(runId);
    },
    // ADR 0047 room dispatch: the closure dereferences conv at request time
    // (product tools assemble before conversations execute anything).
    dispatch: async ({
      fromAgentId,
      conversationId,
      toAgentId,
      instruction,
      brief,
      parentRunId,
      note,
      findings,
      requirementId: namedRequirement,
    }) => {
      // ADR 0070: the work lands in the WORKER'S OWN ROOM, opened under the
      // room that dispatched it. The front desk's room keeps one summary line
      // with a link, so its ledger stays a conversation instead of a mixed
      // stream of everybody's process.
      const reuse = settingsSvc.get<boolean>("dispatch.reuseChildConversation") ?? true;
      const room = await conv.convSvc.dispatchRoom({
        parentConversationId: conversationId,
        workerAgentId: toAgentId,
        reuse,
      });
      const workerAgent = await agentSvc.getById(toAgentId).catch(() => null);
      const workerRoot = workerAgent?.workspacePath ?? "";
      const attached = workerAgent?.config.runtime_config.projects ?? [];
      // The ROOM's project wins over guessing from the brief text: a room
      // bound to a project is a topic, and the topic's directory is the one
      // the worker must work in (ADR 0023 worktree).
      const roomProjectId = conv.convPort.getConversation(conversationId)?.projectId ?? null;
      const roomProject =
        roomProjectId !== null && attached.includes(roomProjectId)
          ? projectSvc.getById(roomProjectId)
          : null;
      const namedProject =
        roomProject ??
        attached
          .map((pid: string) => projectSvc.getById(pid))
          .find((p) => brief.object.includes(p.name) || instruction.includes(p.name)) ??
        null;
      // ADR 0077: the work lands in the REQUIREMENT's checkout. No requirement
      // yet → the dispatch opens one (visible in /requirements) rather than
      // falling back to a copy the agent owns.
      let workerWorktree: string | null = null;
      if (namedProject !== null) {
        let requirementId = namedRequirement ?? workspaceSvc.currentRequirementOf(conversationId);
        // A brief that names a requirement moves the room to it: the switch is
        // the dispatcher's explicit act, not an inference from "newest open".
        if (
          namedRequirement !== undefined &&
          namedRequirement !== workspaceSvc.currentRequirementOf(conversationId)
        ) {
          workspaceSvc.attachConversation({
            conversationId,
            requirementId: namedRequirement,
          });
        }
        if (requirementId === null) {
          const opened = requirementSvc.create({
            title: brief.object.slice(0, 80) || instruction.slice(0, 80),
            goal: instruction.slice(0, 300) || brief.object,
            projectId: namedProject.projectId,
            originConversationId: conversationId,
            createdByAgentId: fromAgentId,
          });
          requirementId = opened.requirementId;
          workspaceSvc.attachConversation({ conversationId, requirementId });
        }
        const checkout = await workspaceSvc.ensureForRequirement({
          requirementId,
          projectId: namedProject.projectId,
        });
        workerWorktree = checkout.path;
        // The worker's room advances the same requirement.
        workspaceSvc.attachConversation({
          conversationId: room.conversationId,
          requirementId,
        });
      }
      const posted = await conv.convSvc.postMessage({
        conversationId: room.conversationId,
        senderMemberId: fromAgentId,
        content: frameBrief({
          fromAgentId,
          brief,
          instruction,
          // H3: the worker must know its OWN directory. The brief otherwise
          // carries the human's path (`/root/my-agent-team/README.md`) and the
          // shell fence refuses every write to it (live 2026-11-23).
          ...(workerRoot !== ""
            ? {
                workspace: {
                  root: workerRoot,
                  ...(workerWorktree !== null ? { worktree: workerWorktree } : {}),
                },
              }
            : {}),
          ...(note !== undefined ? { note } : {}),
          ...(findings !== undefined ? { findings } : {}),
          meta: {
            conversation: conversationId,
            ...(parentRunId !== undefined ? { "parent-run": parentRunId } : {}),
            "to-agent": toAgentId,
          },
        }),
        mode: "normal",
        authorization: `dispatch:${fromAgentId}`,
        ...(parentRunId ? { parentRunId } : {}),
      });
      // The room's summary is the FRONT DESK's line (sender = the dispatcher),
      // ledger-only (`trigger: false`), and carries the child's id so the room
      // can open it.
      const workerName =
        (await agentSvc.getById(toAgentId).catch(() => null))?.config.name ?? toAgentId;
      const head = instruction.length > 80 ? `${instruction.slice(0, 80)}…` : instruction;
      await conv.convSvc.postMessage({
        conversationId,
        senderMemberId: fromAgentId,
        trigger: false,
        content: `→ 已派给 ${workerName}：「${head}」`,
        dispatchTo: { conversationId: room.conversationId },
      });
      const first = posted.triggeredRuns.find((entry) => entry.agentId === toAgentId);
      return {
        agentId: toAgentId,
        runId: first?.runId ?? "",
        inputId: first?.inputId ?? "",
        queued: first?.queued ?? false,
      };
    },
    // ADR 0052: with no name given, the pool picks — idle first, then least
    // recently started, narrowed by the capability the caller asked for.
    pickAgent: async (query) => {
      const rows = await agentSvc.list();
      const load = new Map((await agentRunPort.agentLoad()).map((l) => [l.agentId, l]));
      const candidates = rows
        .filter((row) => row.archivedAt === null && row.config.enabled)
        .map((row) => ({
          id: row.id,
          name: row.config.name,
          description: row.config.description,
          skills: row.config.skills.map((s) =>
            s.description === "" ? s.id : `${s.id}：${s.description}`,
          ),
          role: row.config.role ?? null,
          activeRuns: load.get(row.id)?.activeRuns ?? 0,
          lastRunAt: load.get(row.id)?.lastRunAt ?? 0,
        }));
      // ADR 0058: selection goes through the SAME entry as memory and history
      // recall, so there is one place to fix when "what do we know about this"
      // is wrong. Capability hits carry the agent in `meta`.
      const result = await recall(
        { workers: async () => candidates },
        { sources: ["capability"], brief: query },
      );
      const hit = result.hits[0];
      const agentId = hit?.meta?.agentId;
      if (hit === undefined || agentId === undefined) return null;
      const field = result.searched.find((s) => s.source === "capability")?.detail;
      return {
        agentId,
        reason: [hit.why, field]
          .filter((p): p is string => typeof p === "string" && p !== "")
          .join("; "),
      };
    },
    // ADR 0052 + ADR 0070 handback: resolve the parent run's conversation so a
    // worker running in a child room wakes its dispatcher in the PARENT room.
    handback: async ({ fromAgentId, toAgentId, conversationId, runId, reason, suggestion }) => {
      const currentRun = await agentRunPort.getRun(runId).catch(() => null);
      const parentRun = currentRun?.parentRunId
        ? await agentRunPort.getRun(currentRun.parentRunId).catch(() => null)
        : null;
      const targetConversationId = parentRun?.conversationId ?? conversationId;
      const posted = await conv.convSvc.postMessage({
        conversationId: targetConversationId,
        senderMemberId: fromAgentId,
        content: frameHandbackInput(fromAgentId, reason, suggestion),
        mode: "normal",
        authorization: `handback:${fromAgentId}`,
        parentRunId: runId,
      });
      const first = posted.triggeredRuns.find((entry) => entry.agentId === toAgentId);
      return { runId: first?.runId ?? "", queued: first?.queued ?? false };
    },
    // ADR 0059 D6: report goes upward through the same closure the terminal
    // state uses; progress never wakes, attention/answer do. Never mark
    // result_notified_at on mid-run reports (`terminal: false`).
    notifyParent: async ({
      fromAgentId,
      conversationId,
      runId,
      callId,
      purpose,
      text,
      verification,
    }) =>
      notifyDispatcher({
        fromAgentId,
        conversationId,
        runId,
        terminal: false,
        idempotencyKey: `report:${runId}:${callId ?? Date.now()}`,
        text: frameReportInput(fromAgentId, purpose, text, verification),
        wake: purpose !== "progress",
      }),
    // ADR 0065: the product's only memory writer. It appends to the SAME file
    // ADR 0065 / C2-A: persist human-authorized lessons straight into the
    // agent's personal Wiki page (`personal/<agentId>/memories.md`), so
    // backend has ONE knowledge/memory surface (with git history, visible in
    // /wiki, participating in Wiki recall).
    remember: async ({ agentId, conversationId, text }) => {
      const normalized = text.replace(/\s+/g, " ").trim();
      if (!normalized) return { saved: false, reason: "empty lesson" };
      const pagePath = `personal/${agentId}/memories.md`;
      const source = `conversation:${conversationId}`;
      const line = `- [${new Date().toISOString().slice(0, 10)}] ${normalized}`;
      for (let attempt = 0; attempt < 3; attempt++) {
        const existing = wikiSvc.read(pagePath);
        if (existing) {
          const already = existing.body
            .split("\n")
            .some((row) => row.replace(/^-\s*\[\d{4}-\d{2}-\d{2}\]\s*/, "").trim() === normalized);
          if (already) return { saved: true, reason: "already remembered" };
          const body =
            existing.body.trim() === "" ? line : `${existing.body.replace(/\s+$/, "")}\n${line}`;
          const res = await wikiSvc.patch({
            path: pagePath,
            agentId,
            content: body,
            sources: [source],
            expectedRevision: existing.revision,
          });
          if (res.ok) return { saved: true };
          if (res.reason === "conflict") continue;
          return { saved: false, reason: res.detail };
        }
        const res = await wikiSvc.create({
          path: pagePath,
          agentId,
          title: "Personal Memories",
          content: line,
          sources: [source],
        });
        if (res.ok) return { saved: true };
        if (res.reason === "conflict") continue;
        return { saved: false, reason: res.detail };
      }
      return { saved: false, reason: "concurrent update conflict" };
    },
    // ADR 0059 D6 + ADR 0070: query active runs across BOTH the dispatcher's
    // room and its spawned worker child conversations.
    steerWorker: async ({ fromAgentId, conversationId, toAgentId, runId, callId, message }) => {
      const childIds =
        conv.convPort.listChildConversations?.(conversationId).map((c) => c.conversationId) ?? [];
      const scopeIds = [conversationId, ...childIds];
      const active = (
        await agentRunPort.listActiveRunsForConversations(scopeIds).catch(() => [])
      ).find((candidate) => candidate.agentId === toAgentId);
      if (!active) {
        return {
          ok: false,
          error: `${toAgentId} has no running task in this conversation; dispatch a new task instead of steering`,
        };
      }
      const text = `（${fromAgentId} 转达，优先于原任务）\n${message}`;
      // Same correction as enqueueSteer: the CAS counter is the branch's, not
      // the run's config revision (which is a constant today).
      const steerBranch = await contextPort.getBranch(active.branchId).catch(() => null);
      const enqueued = await agentRunPort.enqueueAndAcquire({
        conversationId: active.conversationId,
        agentId: toAgentId,
        branchId: active.branchId,
        mode: "steer",
        message: { role: "user", text },
        inputIdempotencyKey: `steer:${runId}:${callId}`,
        runIdempotencyKey: `steer:${runId}:${callId}`,
        deliveryIdempotencyKey: `steer:${runId}:${callId}`,
        defaultModel: active.modelRef,
        configRevision: active.configRevision,
        expectedRevision: steerBranch?.revision ?? active.configRevision,
        authorization: `dispatch:${fromAgentId}`,
        parentRunId: runId,
      });
      if (!enqueued.queued || enqueued.acquired) {
        return {
          ok: false,
          error: `${toAgentId} settled before the steer landed; nothing to steer`,
        };
      }
      try {
        await injectSteer.fn(active.branchId, {
          inputId: enqueued.inputId,
          message: { role: "user", text },
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: `steer failed: ${(error as Error).message}` };
      }
    },
    cancelWorker: async ({ fromAgentId, conversationId, toAgentId, reason }) => {
      const childIds =
        conv.convPort.listChildConversations?.(conversationId).map((c) => c.conversationId) ?? [];
      const scopeIds = [conversationId, ...childIds];
      const active = (
        await agentRunPort.listActiveRunsForConversations(scopeIds).catch(() => [])
      ).find((candidate) => candidate.agentId === toAgentId);
      if (!active) {
        return { ok: false, error: `${toAgentId} has no running task in this conversation` };
      }
      // The stop is a human-facing action taken on their behalf: the ledger
      // records it as the caller's, with the reason, before the run settles.
      await conv.convSvc
        .postMessage({
          conversationId,
          senderMemberId: fromAgentId,
          trigger: false,
          content: `（${fromAgentId} 停止了 ${toAgentId} 的工作：${reason}）`,
          authorization: `dispatch:${fromAgentId}`,
          parentRunId: active.runId,
        })
        .catch(() => {});
      try {
        await agentRunExecution?.stop(active.runId);
        return { ok: true, stoppedRunId: active.runId };
      } catch (error) {
        return { ok: false, error: `stop failed: ${(error as Error).message}` };
      }
    },
    // ADR 0048: the roster discovery surface a dispatching agent reads.
    listTeam: async () => rosterCards(),
  });
  let productToolsMcp: Awaited<ReturnType<typeof createProductToolsMcpServer>> | null = null;
  // Default set: product-tools + agent-config + workflow. The workflow DSL
  // server is NOT optional in practice — `<dataDir>/workflows/*.workflow.json`
  // sits outside every agent workspace, so the file tools refuse it ("path
  // escapes workspace") and this MCP server is the agent's only read path
  // into a definition. Leaving it off silently breaks the workflow editor
  // chat and the workflow_design skill.
  const enabledMcpServers = new Set(
    (config.enabledMcpServers ?? "product-tools,agent,workflow")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
  // Per-run bearer registry: tokens are minted at dispatch and revoked at
  // settle (agent-run execution); this is the ONLY accepted MCP auth.
  const productToolsTokenRegistry = createRunTokenRegistry();
  if (config.productToolsMcpUrl && enabledMcpServers.has("product-tools")) {
    const mcpUrl = new URL(config.productToolsMcpUrl);
    productToolsMcp = await createProductToolsMcpServer({
      service: productTools,
      tokenRegistry: productToolsTokenRegistry,
      host: mcpUrl.hostname,
      port: Number(mcpUrl.port) || 0,
    });
    console.log(`[bootstrap] product tools MCP listening at ${productToolsMcp.url}`);
  }
  // Workflow DSL MCP server (per-server control via ENABLED_MCP_SERVERS):
  // lets the agent read/write *.workflow.json through MCP tools. Injected
  // into the workspace .mcp.json below only when enabled.
  let workflowMcp: Awaited<ReturnType<typeof createWorkflowMcpServer>> | null = null;
  if (enabledMcpServers.has("workflow")) {
    workflowMcp = await createWorkflowMcpServer({
      workflowDir: join(config.dataDir, "workflows"),
      proposals: proposalSvc,
      tokenRegistry: productToolsTokenRegistry,
    });
    console.log(`[bootstrap] workflow MCP listening at ${workflowMcp.url}`);
  }

  // Agent-config MCP server (per-server control via ENABLED_MCP_SERVERS):
  // lets the chat agent read/write an agent's config through MCP tools.
  // Injected into the workspace .mcp.json below only when enabled. Mirrors
  // the workflow server: agent_write emits a "changed" SSE event and the
  // edit page adopts it as an unsaved edit.
  let agentConfigMcp: Awaited<ReturnType<typeof createAgentConfigMcpServer>> | null = null;
  if (enabledMcpServers.has("agent")) {
    agentConfigMcp = await createAgentConfigMcpServer({
      readConfig: async (agentId) => {
        const row = await agentSvc.getById(agentId);
        return row?.config ?? null;
      },
      // The tool proposes to an EXISTING agent's edit page; an unknown id has
      // no page to adopt the change, so the call must fail instead of
      // reporting a proposal nobody will ever see.
      agentExists: (agentId) => agentSvc.exists(agentId),
      proposals: proposalSvc,
      tokenRegistry: productToolsTokenRegistry,
    });
    console.log(`[bootstrap] agent-config MCP listening at ${agentConfigMcp.url}`);
  }

  // The execution service exists unconditionally: the Oma is a
  // child process (one Run = one spawn). When the executable is missing,
  // startup continues - /api/models errors and Run dispatch keeps the input
  // unaccepted until the executable exists.
  // T3-2: failed/aborted/timeout runs persist an assistant error message so
  // the failure survives refresh (transient bubbles die with the page).
  const onRunFailed = (input: {
    runId: string;
    conversationId: string;
    agentId: string;
    error: string;
  }): void => {
    void (async () => {
      const msg = {
        messageId: `run:${input.runId}:error`,
        state: "error" as const,
        role: "assistant" as const,
        text: input.error,
        visibility: "conversation" as const,
        conversationId: input.conversationId,
        updatedAt: Date.now(),
        error: { message: input.error },
      };
      conv.convPort.appendLedgerEntry({
        conversationId: input.conversationId,
        kind: "message",
        content: serializeMessageRevision(msg),
        ts: Date.now(),
      });
      // The failure is a row now: the chat channel folds the turn into history, error part included.
      // No duration: a failed run never ran a turn, the error is the row's business.
      await chatWriter.foldCommittedTurn(input.runId, 0);
      // ADR 0059 D5: a dispatched worker's failure is the dispatcher's
      // business too - otherwise a dead worker is silent until the human
      // notices the room went quiet.
      const run = await agentRunPort.getRun(input.runId);
      if (run?.parentRunId && run.authorization?.startsWith("dispatch:") === true) {
        await notifyDispatcher({
          fromAgentId: run.agentId,
          conversationId: run.conversationId,
          runId: input.runId,
          text: frameResultInput(await agentNameOf(run.agentId), "failed", input.error),
          wake: true,
        });
      }
    })().catch((err) => console.error(`[bootstrap] onRunFailed failed for ${input.runId}:`, err));
  };
  const onRunCommitted = (
    runId: string,
    output: Message | undefined,
    _committedSeq: readonly number[],
  ): void => {
    void (async () => {
      const run = await agentRunPort.getRun(runId);
      if (!run || !output) return;
      // Product-owned title (see conversation/title.ts): every harness runs
      // behind ACP, and the title used to arrive on the deleted oma RPC rail as
      // part of the terminal result — the ACP response carries none. The
      // conversation is named after the turn that started it, and the guard
      // retries on later turns while it is still untitled.
      const convRow = conv.convPort.getConversation(run.conversationId);
      if (convRow && !convRow.title && run.terminalResult?.status === "completed") {
        const title = deriveConversationTitle(
          firstUserText(conv.convPort.getLedgerEntries(run.conversationId)),
        );
        if (title) conv.convPort.setConversationTitle(run.conversationId, title);
      }
      // The turn's rows are committed: the chat channel re-states the turn from the projection and
      // moves it from "in flight" to history, so a live surface needs no refresh to see it there.
      await chatWriter.foldCommittedTurn(
        runId,
        Math.max(0, (run.terminalAt ?? Date.now()) - run.createdAt),
      );
      // Observation (ADR 0066, product walk): did this answer hand a decision
      // back without ever opening an ask? Recorded only - surfacing it waits
      // for a measured hit rate, because a text heuristic has false positives
      // and noise in the inbox trains people to ignore it.
      void (async () => {
        try {
          const answer = extractText(output);
          if (!endsWithQuestion(answer)) return;
          const asks = await agentRunPort.listPendingActions(runId);
          if (asks.some((action) => action.kind === "ask")) return;
          services.opsStore.appendRunEvent(runId, "unasked_question", {
            tail: lastParagraph(answer).slice(0, 200),
          });
        } catch {
          /* an observation must never disturb the turn */
        }
      })();
      // Observation (ADR 0075): the two boundaries the slot fix did not
      // repair. Counted separately so the rate of each is readable.
      void (async () => {
        try {
          const role = (await agentSvc.getById(run.agentId).catch(() => null))?.config.role;
          if (role === "worker") return;
          const inputs = await agentRunService.listInputs(run.branchId).catch(() => []);
          const mine = inputs.find((i) => i.runId === runId);
          const requestText = typeof mine?.message?.text === "string" ? mine.message.text : "";
          if (requestText === "") return;
          const dispatchedRows = db
            .query(
              "SELECT 1 FROM product_tool_call WHERE run_id = ? AND tool_name = 'dispatch' LIMIT 1",
            )
            .all(runId);
          const dispatched = dispatchedRows.length > 0;
          const pending = await agentRunPort.listPendingActions(runId).catch(() => []);
          const decided = await agentRunPort.listDecidedActions(runId).catch(() => []);
          const asked =
            pending.some((a) => a.kind === "ask") || decided.some((d) => d.kind === "ask");
          if (isIrreversibleRequest(requestText) && !asked && !dispatched) {
            services.opsStore.appendRunEvent(runId, "irreversible_unasked", {
              head: requestText.slice(0, 160),
            });
          }
          if (isStatusQuestion(requestText) && dispatched) {
            services.opsStore.appendRunEvent(runId, "status_question_dispatched", {
              head: requestText.slice(0, 160),
            });
          }
        } catch {
          /* an observation must never disturb the turn */
        }
      })();
      // Observation (ADR 0075, live 2026-11-22): the front desk produced a
      // long-form answer with NO dispatch. That is the "it did the work
      // itself" failure the routing rules exist to prevent, and the only way
      // to know whether a rule change helped is to count it. Recorded, never
      // gated: a short explanation is a legitimate answer, and a heuristic
      // that blocks answers would be worse than the behaviour it measures.
      void (async () => {
        try {
          const frontDesk = (await agentSvc.getById(run.agentId).catch(() => null))?.config.role;
          if (frontDesk === "worker") return;
          const answer = extractText(output);
          if (answer.length < 800) return;
          // Read the durable tool-call ledger: a dispatch leaves a row even
          // when the model never mentioned it in prose.
          const dispatchedRows = db
            .query(
              "SELECT 1 FROM product_tool_call WHERE run_id = ? AND tool_name = 'dispatch' LIMIT 1",
            )
            .all(runId);
          if (dispatchedRows.length > 0) return;
          services.opsStore.appendRunEvent(runId, "unrouted_work", {
            chars: answer.length,
            head: answer.slice(0, 160),
          });
        } catch {
          /* an observation must never disturb the turn */
        }
      })();
      // ADR 0059 D5: the worker's terminal state travels back to whoever
      // dispatched it. Gated on `dispatch:` authorization - a `result:` run is
      // the dispatcher's own turn answering a notification, and notifying its
      // "parent" would ping-pong the same fact forever. `handback:` runs
      // already woke the dispatcher through the tool itself.
      if (run.parentRunId && run.authorization?.startsWith("dispatch:") === true) {
        // ADR 0076 H1: a dispatched worker's report IS a deliverable, so the
        // backend materializes it as an artifact when the model did not. Live
        // 2026-11-22: the brief carried `<delivery>` and both workers still
        // answered in prose — the handoff then had nothing to hand over.
        // Relying on the model to remember is not a contract; making the file
        // is. Best effort: an upload failure must not block the notification.
        const finalText = extractText(output);
        let artifacts = artifactUrlsOf(runId);
        if (artifacts.length === 0 && finalText.trim() !== "") {
          try {
            const uploaded = await artifactService.upload({
              folder: "reports",
              filename: `${runId}.md`,
              content: finalText,
              encoding: "utf8",
              source: { runId, conversationId: run.conversationId, agentId: run.agentId },
            });
            artifacts = [uploaded.url];
          } catch (err) {
            console.error(
              `[bootstrap] report artifact for ${runId} failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        await notifyDispatcher({
          fromAgentId: run.agentId,
          // The dispatcher lives in the PARENT room (ADR 0070: the worker's
          // room is its own). Posting the wake into the child room addressed to
          // an agent who is not a member there starts nothing and lands where
          // nobody reads it — live 2026-11-22 the chain stopped exactly here.
          conversationId:
            conv.convPort.getConversation(run.conversationId)?.parentConversationId ??
            run.conversationId,
          runId,
          // ADR 0075/0076: carry the deliverables, not a description of them.
          text: frameResultInput(
            await agentNameOf(run.agentId),
            "completed",
            finalText,
            artifacts,
            planOfDispatcher(
              conv.convPort.getConversation(run.conversationId)?.parentConversationId ?? null,
            ),
          ),
          wake: true,
        });
      }
    })().catch((err) => console.error(`[bootstrap] onRunCommitted failed for ${runId}:`, err));
  };

  /** The run's rows are committed, so the projection is the authority on its turn: re-state the
   *  turn on the chat channel (the streamed parts were a preview without ledger coordinates) and
   *  fold it into the history. Runs whose events this process never streamed are skipped - the
   *  surface that asks for a snapshot gets the turn from the projection anyway. */

  const codingAgentCommand = resolveOmaCommand(config, { env: providerSvc.getProviderEnv() });
  const codingAgentCatalog = createOmaModelCatalog(codingAgentCommand);

  const refreshOmaProviderEnv = () => {
    codingAgentCommand.env = resolveOmaCommand(config, { env: providerSvc.getProviderEnv() }).env;
    codingAgentCatalog.invalidate();
  };

  // Same resolution the native adapter used: this box has no `oma` on PATH.
  const omaAcpArgv = resolveOmaAcpArgv(config, { env: providerSvc.getProviderEnv() });

  // The harness axis (ADR 0040 decision 7). Reading a harness's models costs a
  // session, so the catalog caches them; the oma entry reuses the launch
  // resolution above, the same one the dispatch uses.
  const harnessCatalog = createHarnessCatalog({
    harnesses: () => Object.entries(ACP_AGENTS).map(([key, entry]) => ({ key, name: entry.name })),
    probe: (key) =>
      // The cwd only has to exist: posix_spawn answers ENOENT for a missing
      // working directory, which reads exactly like a missing binary. A model
      // catalog does not care where it runs, so use the dir the backend owns.
      probeHarnessCatalog({ key, cwd: config.dataDir, commands: { oma: omaAcpArgv } }),
  });
  // Network allowlist (security-debt gate 1: network deployment). An
  // unprivileged bwrap can only cut the network outright or leave it open, so
  // this is the MIDDLE TIER and it is COOPERATIVE: children get HTTP(S)_PROXY,
  // which npm/pip/curl/git honour, and a script that ignores the env still
  // reaches the network. Hard per-host limits need a privileged deployment
  // (nftables per uid/cgroup) - do not describe this as a whitelist.
  const configuredAllowlist = settingsSvc.get("sandbox.networkAllowlist");
  const allowlistHosts = Array.isArray(configuredAllowlist)
    ? configuredAllowlist.filter(
        (host): host is string => typeof host === "string" && host.trim() !== "",
      )
    : [];
  const sandboxProxy = allowlistHosts.length > 0 ? await startAllowlistProxy(allowlistHosts) : null;

  const acpBackend = new AcpBackend({
    onSessionBound: (runId, nativeRef) => onSessionBound.fn(runId, nativeRef),
    // The child's permission classifier defaults to THE RUN'S model, and a
    // flash-tier model classifying permissions escalates almost everything to
    // a human — observed live: every bash in one turn asked, one card after
    // another. This deployment knob pins the classifier to a stronger model
    // without touching the chat model. Explicit passthrough only: the child
    // env is otherwise constructed, never inherited wholesale.
    // ponytail: only the model is forwarded — the child's classifier timeout
    // default is fine and no deployment declares one; add it to
    // packages/config when one does.
    env: {
      ...(config.omaPermissionClassifierModel
        ? { OMA_PERMISSION_CLASSIFIER_MODEL: config.omaPermissionClassifierModel }
        : {}),
      ...(config.browserLocalNetwork ? { OMA_BROWSER_LOCAL_NETWORK: "1" } : {}),
      ...(sandboxProxy
        ? {
            HTTP_PROXY: sandboxProxy.url,
            HTTPS_PROXY: sandboxProxy.url,
            http_proxy: sandboxProxy.url,
            https_proxy: sandboxProxy.url,
            NO_PROXY: "127.0.0.1,localhost,::1",
            no_proxy: "127.0.0.1,localhost,::1",
          }
        : {}),
    },
    // Registry-key launch overrides, the omaBin/ompBin convention: a
    // deployment where the agent CLI lives outside PATH names it here.
    commands: { oma: omaAcpArgv },
    // MCP-over-ACP (ADR 0039 appendix two): when the agent advertises the
    // capability, its product tools ride the ACP connection itself, so no
    // SSE server, port or bearer file is involved for those runs. Same
    // dispatch as the SSE rail, so authority and keying cannot drift.
    ...(enabledMcpServers.has("product-tools")
      ? {
          acpMcpProvider: {
            name: "product-tools",
            serverId: "product-tools",
            ...createProductToolsDispatch({ service: productTools }),
          },
        }
      : {}),
  });
  // The ACP kind's catalog lists registry keys, and it is also the catalog for the kinds that now
  // alias to it (ADR 0040 R3): a picker that offered the native models would offer ids the run
  // never uses. Their `backend` entries stay until the kinds are deleted - the alias routes runs
  // to ACP, so they are already unreachable.
  const acpCatalog = new AcpModelCatalog();
  // One execution rail (ADR 0040): every harness runs through the single ACP
  // client; the run's model id names the registry key. The provider catalogue
  // above is the oma harness's LLM axis (/api/models), not a dispatch table.
  const backends: BackendRegistry = {
    acp: { backend: acpBackend, catalog: acpCatalog },
  };
  // Catalog honesty (see served-models.ts): the model picker must not offer a
  // declared id the provider no longer serves. "Unknown" never flips anything.
  const servedModelKnowledge = createServedModelKnowledge({
    probe: createProviderModelProbe({ env: process.env }),
  });
  const mcpRuntimeStatus = createMcpRuntimeStatusStore();
  const agentNameOf = async (agentId: string | null): Promise<string> => {
    if (agentId === null) return "unknown member";
    const agent = await agentSvc.getById(agentId).catch(() => null);
    return agent?.config.name ?? agentId;
  };

  // Wire Project, MCP, RuntimeOps, Lark setup, and resource reconciliation.
  const {
    getSetupManager,
    disposeSetupManager,
    opsSvc,
    larkSurfaceFactsOf,
    projectPort,
    projectSvc,
    mcpSvc,
    prepareMcpBridge,
    productToolsManifest,
    reconcileAgent: reconcileAgentImpl,
  } = wireOpsAndMcp({
    config,
    db,
    ulid,
    agentSvc,
    convPort: conv.convPort,
    skillPackPort,
    larkBotRegistry,
    opsStore: services.opsStore,
    mcpClientManager,
    mcpRuntimeStatus,
    entityLabels,
    enabledMcpServers,
    getWorkflowMcpUrl: () => workflowMcp?.url ?? null,
    getAgentConfigMcpUrl: () => agentConfigMcp?.url ?? null,
  });
  reconcileAgent.fn = reconcileAgentImpl;

  // Wire ADR 0077 requirement workspaces, run workspace resolution, budget gate, and memory recall.
  const {
    workspaceSvc,
    checkoutOf,
    peekWorkspaceFor,
    workspaceForRun,
    modelCostsSnapshot,
    budgetGate,
    memoryRecall,
  } = wireWorkspaceAndRecall({
    config,
    db,
    ulid,
    agentSvc,
    convPort: conv.convPort,
    agentRunPort,
    requirementSvc,
    settingsSvc,
    codingAgentCatalog,
    getProjectSvc: () => projectSvc,
  });

  // Wire AHP read-only state source, WebSocket host, and live chat writer (zero TDZ forward refs).
  const { browserWsBase, ahpHost, chatWriter } = wireAhp({
    config,
    agentSvc,
    harnessCatalog,
    convPort: conv.convPort,
    agentRunPort,
    artifactService,
    opsStore: services.opsStore,
    peekWorkspaceFor,
  });

  onContinuityRecorded.fn = (input) => {
    void chatWriter
      .announceContinuity(input)
      .catch((err) =>
        console.error(
          `[bootstrap] continuity announcement failed for ${input.conversationId}:`,
          err,
        ),
      );
  };

  const agentRunExecution = createAgentRunExecutionService({
    budgetGate,
    // ADR 0075: a request just parked - surface it to its owner (this closure
    // is defined above and dereferences late bindings at request time).
    onRequestCreated: (input) => {
      void surfaceRequest(input).catch(async (err: unknown) => {
        console.error(
          `[bootstrap] request notice failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        // The machine route (the owner agent) could not be told, so it will
        // never answer: hand the question to the person instead of leaving an
        // orphan in the inbox that reads as "the agent is on it".
        await agentRunPort
          .escalateActionToUser?.(pendingActionId(input.runId, input.callId))
          .catch(() => undefined);
      });
    },
    workspaceLocks,
    productToolsTokenRegistry,
    runTimeoutMs: config.runTimeoutMs,
    runPort: agentRunPort,
    contextPort,
    // ADR 0055: recall reads this conversation's ledger; scoped so a global
    // hit list can never crowd out what was said in this room.
    conversationSearch: (keyword, limit, scope) => convPort.searchLedger(keyword, limit, scope),
    onRecall: (runId, hits) => {
      if (recallByRun.size >= 200) {
        const oldest = recallByRun.keys().next().value;
        if (oldest !== undefined) recallByRun.delete(oldest);
      }
      recallByRun.set(runId, hits);
    },
    ledgerResolver,
    backends,
    idGen: { ulid },
    resolveWorkspace: ({ conversationId, agentId, runId }) =>
      workspaceForRun({ conversationId, agentId, ...(runId !== undefined ? { runId } : {}) }),
    // ADR 0064: the front desk's long-term memory, read from its workspace.
    // Vector voice when an embedding model is configured; keyword-only
    // otherwise (narrower, never broken).
    searchMemory: (input) => memoryRecall.search(input),
    // ADR 0080: work the PA wrote down is recalled the way memory is, so a new
    // turn sees "this already exists" instead of opening a duplicate item.
    searchRequirements: (query, limit) => {
      const needle = query.toLowerCase();
      return requirementSvc
        .list(false)
        .filter((r) => `${r.title}\n${r.goal}`.toLowerCase().includes(needle))
        .slice(0, limit)
        .map((r) => ({
          requirementId: r.requirementId,
          title: r.title,
          goal: r.goal,
          status: r.status,
          at: r.updatedAt,
        }));
    },
    onHumanInputResolved: (input) => {
      // A settled request has to stop reading as pending on the surface too, without waiting for
      // the turn to commit: a card that survives its own click reads as "my answer did not land".
      void chatWriter
        .announceHumanInput(input)
        .catch((err) =>
          console.error(`[bootstrap] human input announcement failed for ${input.runId}:`, err),
        );
    },
    onLiveEvent: chatWriter.onLiveEvent,
    productToolsEntrypoint: config.productToolsMcpUrl
      ? `sse:${sseUrlEndpoint(config.productToolsMcpUrl)}`
      : "stdio:/nonexistent",
    // H1: the bridge is the only author of the workspace .mcp.json —
    // re-written from source of truth immediately before every spawn, with
    // user MCP secrets extracted into spawn env placeholders.
    rewriteWorkspaceBridge: async (agentId, root) => {
      const prepared = await prepareMcpBridge(agentId);
      writeMcpConfig(root, prepared.servers);
      writeProductToolsManifest(root, productToolsManifest());
      return { env: prepared.env, expandableVars: prepared.expandableVars };
    },
    onRunCommitted,
    // ADR 0072/0076 delivery gate: a change is "verified" only when a DIFFERENT
    // agent ran after the producing run and changed nothing. The line is
    // appended by the deployment, so a model cannot claim a second opinion it
    // never got (live 2026-11-23 a change shipped with none).
    deliveryNote: async (run) => {
      if (!run.agentId) return undefined;
      const agent = await agentSvc.getById(run.agentId).catch(() => null);
      // Workers answer their dispatcher; only a front desk delivers to a person.
      if (agent?.config.role === "worker") return undefined;
      // ADR 0077: the subject is the REQUIREMENT. Every room that advanced it
      // counts — the same work continues from a DM, a group and a direct line —
      // so the runs come by requirement, not by room. Rooms with no tracked
      // requirement fall back to what was dispatched from this room (a producer
      // is never in the front desk's own conversation, which kept the gate
      // silent — measured 2026-11-23).
      const WINDOW_MS = 6 * 60 * 60_000;
      const requirementId = workspaceSvc.currentRequirementOf(run.conversationId);
      const byRequirement =
        requirementId === null
          ? null
          : await agentRunPort.listRunsForRequirement?.(requirementId, WINDOW_MS).catch(() => null);
      const recent =
        byRequirement ??
        (await agentRunPort
          .listDispatchedRuns?.(run.conversationId, WINDOW_MS)
          .catch(() => null)) ??
        (await agentRunPort
          .listRecentRunsForConversations([run.conversationId], WINDOW_MS)
          .catch(() => []));
      const note = deliveryNoteOf({
        selfAgentId: run.agentId,
        runs: recent.map((r) => ({
          runId: r.runId,
          agentId: r.agentId,
          parentRunId: r.parentRunId,
          createdAt: r.createdAt,
          terminalAt: r.terminalAt,
          status: r.terminalResult?.status ?? r.status,
        })),
        produced: (runId) =>
          services.opsStore
            .listRunEvents(runId, 2000)
            .some((e) => producedByEvent(JSON.stringify(e))),
        deliveryOf: (runId) => {
          const event = services.opsStore
            .listRunEvents(runId, 2000)
            .find((e) => e.type === "project_delivered");
          if (event === undefined) return undefined;
          const data = event.data as { branch?: unknown; compareUrl?: unknown };
          if (typeof data.branch !== "string") return undefined;
          return {
            branch: data.branch,
            compareUrl: typeof data.compareUrl === "string" ? data.compareUrl : null,
          };
        },
      });
      console.log(
        `[delivery-gate] run=${run.runId.slice(0, 12)} dispatched=${recent.length} → ${note ?? "verified"}`,
      );
      return note;
    },
    // ADR 0060 D6: recovery saw a terminal dispatched run with no confirmed
    // notice - deliver it now. Same closure as the live path, so the rails and
    // the depth guard stay in one place.
    onRunResultUndelivered: (run) => {
      void (async () => {
        const outcome = run.terminalResult;
        const text =
          outcome?.status === "completed"
            ? extractText(finalAnswerMessage(outcome.messages) ?? {})
            : (outcome?.error ?? "（没有记录失败原因）");
        await notifyDispatcher({
          fromAgentId: run.agentId,
          conversationId: run.conversationId,
          runId: run.runId,
          text: frameResultInput(
            await agentNameOf(run.agentId),
            outcome?.status === "completed" ? "completed" : (outcome?.status ?? "failed"),
            text,
          ),
          wake: true,
        });
      })().catch((err) =>
        console.error(`[bootstrap] result re-delivery failed for ${run.runId}:`, err),
      );
    },
    onRunFailed,
    onRunTerminated: (runId) => productTools.cancelAsksForRun(runId),
    persistRunEvent: (runId, event) => {
      services.opsStore.appendRunEvent(
        runId,
        event.type,
        event as unknown as Record<string, unknown>,
      );
      return Promise.resolve();
    },
    onMcpMountResult: (result) => {
      mcpRuntimeStatus.record({ ...result, at: Date.now() });
    },
  });
  // Late-bound: ask_question routes onto the run's live SSE stream.
  broadcastAskEvent = ({ runId, callId, question }) => {
    agentRunExecution.broadcastRunEvent(runId, {
      type: "ask_requested",
      payload: { callId, questions: question.questions },
    });
  };
  // Late-bound for the same reason: the plan strip rides the run's live stream.
  onMessagesUndone.fn = ({ conversationId }) => {
    void chatWriter.announceMessagesUndone(conversationId).catch((err) => {
      console.error(`[ahp] undo announce failed for ${conversationId}:`, err);
    });
  };
  broadcastTodoEvent = ({ runId, items }) => {
    agentRunExecution.broadcastRunEvent(runId, {
      type: "backend.oma.todo_update",
      payload: { items },
    });
  };

  dispatchRun.fn = (runId: string) => agentRunExecution.dispatch(runId);
  injectSteer.fn = (
    branchId: string,
    input: { inputId: string; message: Message },
    opts?: { keepIfIdle?: boolean },
  ) => agentRunExecution.injectSteer(branchId, input, opts);
  isLive.fn = (runId: string) => agentRunExecution.isLive(runId);
  isInflight.fn = (runId: string) => agentRunExecution.isInflight(runId);
  abortStaleRun.fn = (runId: string) => agentRunExecution.abortStaleRun(runId);

  // ─── Coding, Worktrees, Workflows & Timers ──────────────────
  const { worktreeOps, resolveCodingTarget, codingRegistry, restoreCodingTerminals } =
    wireCodingAndWorktrees({
      config,
      db,
      agentSvc,
      projectPort,
      projectSvc,
      workspaceSvc,
    });

  const { workflowExecutionService, workflowTriggerScheduler, workflowApp } = wireWorkflows({
    config,
    db,
    ulid,
    settingsSvc,
    agentSvc,
    agentRunService,
    agentRunExecution,
    convPort,
    conversationService: conv.convSvc,
    artifactService,
    entityLabels,
  });

  // Reminder tick (raft step 2): DB rows are the truth, so a 30s scan is
  // restart-safe (missed reminders fire on the first tick after boot).
  const reminderInterval = setInterval(() => {
    void reminderSvc.fireDue().catch((err: unknown) => {
      console.error("[reminder] tick failed:", err instanceof Error ? err.message : err);
    });
  }, 30_000);

  // Human-node timeouts (DSL `timeoutMs`): a parked execution has no live loop,
  // so this scan is its only clock.
  const humanTimeoutInterval = setInterval(() => {
    void workflowExecutionService.expireHumanTimeouts().catch((err: unknown) => {
      console.error(
        "[workflow] human timeout tick failed:",
        err instanceof Error ? err.message : err,
      );
    });
  }, 30_000);

  const artifactRetentionDays = config.artifactRetentionDays ?? 0;
  const sweepArtifacts = () => {
    void artifactService
      .purgeOlderThan(artifactRetentionDays)
      .then((removed) => {
        if (removed > 0) {
          console.log(
            `[artifacts] retention removed ${removed} artifact(s) older than ${artifactRetentionDays}d`,
          );
        }
      })
      .catch((err: unknown) => {
        console.error(
          "[artifacts] retention sweep failed:",
          err instanceof Error ? err.message : err,
        );
      });
  };
  if (artifactRetentionDays > 0) sweepArtifacts();
  const artifactRetentionInterval = setInterval(sweepArtifacts, 24 * 60 * 60 * 1000);
  const retentionSweeper = createRetentionSweeper(db);

  const passwordSvc = createPasswordService(settingsSvc, { dataDir: config.dataDir });

  const seeded = await passwordSvc.seedFromBootstrap(config.bootstrapPassword);
  if (seeded === "seeded") {
    console.error("[auth] login password seeded into the database from MOCK_PASSWORD");
  } else if (seeded === "reset") {
    console.error("[auth] operator reset applied: the stored login password was dropped");
  } else if (seeded === "too-short") {
    console.error(
      `[auth] MOCK_PASSWORD is shorter than ${MIN_PASSWORD_LENGTH} characters; not seeding it as the login password`,
    );
  } else if (seeded === "none") {
    console.error(
      "[auth] no login password stored and no MOCK_PASSWORD bootstrap in this process's env;",
      "set MOCK_PASSWORD or run scripts/reset-login-password.sh once the console is up",
    );
  }

  const featureSet: FeatureSet = {
    agents: agentRoutes(
      agentSvc,
      {
        listForAgent: (id: string) =>
          skillPackSvc
            .listForAgent(id)
            .then((rows: SkillPackRow[]) =>
              rows.map((r) => ({ id: r.id, name: r.name, status: r.status })),
            ),
        setAgentPacks: async (id: string, packIds: string[]) => {
          await skillPackSvc.setAgentPacks(id, packIds);
          await reconcileAgent.fn(id);
        },
      },
      identityStore,
      (id: string) => larkBotRegistry.statusOf(id),
      getSetupManager,
      (id: string) => projectSvc.exists(id),
      // Skill pack symlinks resolve into `<dataDir>/skill-packs`; narrow the
      // read-only workspace viewer to ONLY that subdir so sibling secrets in
      // `<dataDir>` (lark-bot/*.env, workflows/, other agents) stay unreachable.
      [join(config.dataDir, "skill-packs")],
      larkSurfaceFactsOf,
    ),
    conversations: conversationRoutes(
      conv.convSvc,
      ulid,
      (id: string) => projectSvc.exists(id),
      async (id: string) => {
        try {
          return (await agentSvc.getById(id)).config.role;
        } catch {
          return undefined;
        }
      },
      {
        conversationIdsForRequirement: (requirementId: string) => {
          const rows = db
            .query(
              `SELECT conversation_id FROM conversation_requirement WHERE requirement_id = ?
               UNION
               SELECT conversation_id FROM conversation WHERE current_requirement_id = ?
               UNION
               SELECT origin_conversation_id AS conversation_id FROM requirement WHERE requirement_id = ? AND origin_conversation_id IS NOT NULL`,
            )
            .all(requirementId, requirementId, requirementId) as Array<{ conversation_id: string }>;
          return rows.map((r) => r.conversation_id);
        },
        labelResolver: entityLabels,
      },
    ),
    reminders: reminderRoutes(reminderSvc),
    ops: opsRoutes(opsSvc),
    agentRuns: agentRunRoutes({
      db,
      agentRunService,
      agentRunExecution,
      // ADR 0075 P4b: correct a machine answer. The row keeps its id; the
      // audit flips to `user`; the WORKER hears it in its own room, so the
      // correction is not a note the machine made to itself.
      correctAnswer: async ({ actionId, response }) => {
        const action = await agentRunPort.getPendingAction(actionId);
        if (action === null) return { ok: false as const, error: "request not found" };
        if (action.status !== "resolved") {
          return { ok: false as const, error: "only a resolved request can be corrected" };
        }
        const answeredBy = action.answeredBy ?? null;
        if (answeredBy === null || answeredBy === "user") {
          return { ok: false as const, error: "no agent answer to correct" };
        }
        if (agentRunPort.correctActionResponse === undefined) {
          return { ok: false as const, error: "correction is not supported by this port" };
        }
        // The row flips its author to `user`; without this record the original
        // answerer and what it cited are gone, and a correction rate cannot be
        // computed from the current row alone (audit G2).
        services.opsStore.appendRunEvent(action.runId, "answer_corrected", {
          actionId,
          originalAnsweredBy: answeredBy,
          originalEvidence: action.evidence ?? [],
          correctedBy: "user",
        });
        await agentRunPort.correctActionResponse(actionId, response);
        const run = await agentRunPort.getRun(action.runId).catch(() => null);
        if (run === null) return { ok: true as const };
        await conv.convSvc.postMessage({
          conversationId: run.conversationId,
          senderMemberId: "user",
          content: [
            `【更正】你之前请求 ${actionId} 的回答已由人更正。`,
            "以这次的内容为准，重做受影响的部分；如有冲突，说明你按哪一条执行。",
            `更正内容：${JSON.stringify(response).slice(0, 800)}`,
          ].join("\n"),
        });
        return { ok: true as const };
      },
      // ponytail: catalog prices snapshotted once per boot; catalogs are
      // static for the process lifetime (env/config driven).
      // The catch is load-bearing, not decoration: this promise is BORN at
      // wiring time but only awaited by a request, so if a backend's catalog
      // call fails (a bad/mismatched `oma --list-models`) the rejection is
      // unhandled and takes the whole process down right after it listened.
      // Pricing is optional — unpriced models use the backend-reported
      // usage.costUsd — so degrade to "no catalog" and keep booting.
      modelCosts: modelCostsSnapshot,
      budgetGate,
      labelResolver: entityLabels,
    }),
    coding: codingRoutes({
      registry: codingRegistry,
      resolveTarget: resolveCodingTarget,
      wsBase: browserWsBase,
      labelResolver: entityLabels,
      requirementOfConversation: (conversationId: string) => {
        const row = db
          .query(
            "SELECT current_requirement_id FROM conversation WHERE conversation_id = ? LIMIT 1",
          )
          .get(conversationId) as { current_requirement_id: string | null } | null;
        return row?.current_requirement_id ?? null;
      },
    }),
    ahp: ahpHost.routes,
    requirements: requirementRoutes(requirementSvc, {
      requirementIdsForConversation: (conversationId: string) => {
        const rows = db
          .query(
            `SELECT requirement_id FROM conversation_requirement WHERE conversation_id = ?
             UNION
             SELECT current_requirement_id AS requirement_id FROM conversation WHERE conversation_id = ? AND current_requirement_id IS NOT NULL`,
          )
          .all(conversationId, conversationId) as Array<{ requirement_id: string }>;
        return rows.map((r) => r.requirement_id);
      },
      labelResolver: entityLabels,
    }),
    wiki: wikiRoutes(wikiSvc),
    projects: projectRoutes(projectSvc, worktreeOps),
    skillPacks: skillPackRoutes(skillPackSvc, config.dataDir),
    mcp: mcpRoutes(mcpSvc),
    workflowExecutions: workflowApp,
    artifacts: artifactRoutes(artifactService),
    productTools,
    settings: settingsRoutes(settingsSvc),
    // ADR 0040 + 2026-11-23: adoption APPLIES. The two appliers are the same
    // paths the HTTP routes use, so a proposal cannot do something a person
    // could not do by hand.
    proposal: proposalRoutes(proposalSvc, {
      updateAgent: async (agentId, input) => {
        await agentSvc.update(agentId, input as Parameters<typeof agentSvc.update>[1]);
      },
      createProject: async ({ name, repoUrl, defaultBranch, attachTo }) => {
        const created = await projectSvc.createProject({
          name,
          repoUrl,
          ...(defaultBranch !== undefined ? { defaultBranch } : {}),
        });
        for (const agentId of attachTo) {
          const agent = await agentSvc.getById(agentId).catch(() => null);
          if (!agent) continue;
          const current = agent.config.runtime_config.projects;
          if (current.includes(created.projectId)) continue;
          await agentSvc.update(agentId, { projects: [...current, created.projectId] });
        }
        return created.projectId;
      },
      // A workflow proposal is adopted only when the saved definition IS the proposal (the
      // editor's own save writes the graph; the decision only reads it). Same id rule and
      // directory as the workflow routes.
      readWorkflowDefinition: async (workflowId) => {
        if (!/^[A-Za-z0-9._-]+$/.test(workflowId)) return null;
        const file = join(config.dataDir, "workflows", `${workflowId}.workflow.json`);
        if (!existsSync(file)) return null;
        return JSON.parse(await Bun.file(file).text());
      },
      updateProject: async (projectId, patch) => {
        try {
          await projectSvc.update(projectId, patch);
        } catch (err) {
          // The reason the project route would give. The row stays pending, so the person can
          // fix the form and save again.
          throw new ProposalNotApplicable(err instanceof Error ? err.message : String(err));
        }
      },
    }),

    auth: authRoutes(passwordSvc),

    providers: providerRoutes(providerSvc, { onChange: refreshOmaProviderEnv }),

    harnesses: harnessRoutes(harnessCatalog),
    models: modelRoutes({
      // The provider axis only (ADR 0040 decision 7): what the oma harness
      // actually serves, straight from `oma --list-models`. Harness keys are
      // NOT models and live in /api/harnesses; the two pickers read the two
      // lists and never mix.
      list: async () => {
        const rows = (await codingAgentCatalog.list()).models.map((m) => ({
          ...m,
          backendKind: "oma",
        }));
        // Kick discovery for every provider on this page; answers land
        // asynchronously (serves() never blocks) and flip availability
        // to false only when the provider is known NOT to serve the id.
        servedModelKnowledge.refresh([...new Set(rows.map((m) => providerOfModelId(m.id)))]);
        return rows.map((m) => ({
          id: m.id,
          name: m.displayName ?? m.id,
          available: applyServedAvailability(
            m.available,
            servedModelKnowledge.serves(providerOfModelId(m.id), bareModelId(m.id)),
          ),
          reasoning: m.reasoning,
          input: m.inputModalities,
          cost: m.cost,
          contextWindow: m.contextWindow,
          maxTokens: m.maxOutputTokens,
          backendKind: m.backendKind,
        }));
      },
    }),
  };

  // ─── Lifecycle ──────────────────────────────────────────────

  // Self-smoke cron (docs/insights.md I4): when SMOKE_CRON is set, spawn
  // the workflow smoke as a separate process on schedule. A workflow
  // script-node cannot host this - the smoke boots a second in-process
  // backend, which would be circular inside a product execution.
  let smokeCron: { stop(): unknown } | undefined;

  let prepared = false;
  async function prepare(): Promise<void> {
    if (prepared) return;
    prepared = true;
    // Settle durable run/workflow state BEFORE accepting HTTP traffic (P1-7).
    // `recover()` settles DB rows synchronously and fires recovered dispatches
    // asynchronously, so boot never deadlocks behind a 24h HITL run.
    await agentRunExecution.recover();
    await workflowExecutionService.recover();
  }

  async function start(): Promise<void> {
    await prepare();
    await workflowTriggerScheduler.sync();
    // Restore persisted coding terminals only when the server actually starts
    // (not during installFeatures in unit tests).
    void restoreCodingTerminals();
    // Reminder catch-up: anything due while the process was down fires now.
    retentionSweeper.start();
    void reminderSvc.fireDue().catch((err: unknown) => {
      console.error("[reminder] boot catch-up failed:", err instanceof Error ? err.message : err);
    });
    // Boot-time bot pull-up: a lark-enabled agent's bot used to start only
    // when its config was re-saved, so a backend restart silently dropped
    // every bot until someone touched the agent. Runs after listen (main
    // calls start() post server.start), so the children can connect.
    // Live agents only: an archived agent keeps its lark config, so listing
    // archived rows here resurrected a bot for a deleted agent on every boot
    // ("boot start for <id>" then a restart loop against a missing entry).
    for (const agent of await agentSvc.list()) {
      const lk = agent.config.lark;
      const bootable =
        agent.config.enabled === true && lk.enabled === true && lk.profile_ref !== "";
      if (!bootable) continue;
      larkBotRegistry
        .ensureLarkBot(agent.id, lk.bot_display_name || null, lk.profile_ref)
        .then(() => console.log(`[lark-bot] boot start for ${agent.id}`))
        .catch((err: unknown) =>
          console.error(
            `[lark-bot] boot start failed for ${agent.id}:`,
            err instanceof Error ? err.message : String(err),
          ),
        );
    }
    const smokeCronExpr = config.smokeCron;
    if (smokeCronExpr) {
      const smokeEntry = join(import.meta.dir, "../../../../scripts/smoke-workflow.ts");
      if (!existsSync(smokeEntry)) {
        console.warn(`[smoke] script not found at ${smokeEntry}; skipping smoke schedule`);
      } else {
        smokeCron = Bun.cron(smokeCronExpr, () => {
          void (async () => {
            console.log(`[smoke] workflow smoke start ${new Date().toISOString()}`);
            const proc = Bun.spawn([process.execPath, smokeEntry], {
              stdout: "inherit",
              stderr: "inherit",
            });
            const code = await proc.exited;
            console.log(`[smoke] workflow smoke exit=${code}`);
          })();
        });
        console.log(`[smoke] workflow smoke scheduled: ${smokeCronExpr}`);
      }
    }
  }

  async function dispose(): Promise<void> {
    // Order matters (P1-18):
    // 1. Stop all new-work producers (cron, timers, workflow trigger scheduler).
    // 2. Kill every running agent child & drain in-flight dispatches + PTYs.
    // 3. Close local MCP servers and sandbox allowlist proxy.
    // 4. Dispose Lark supervisor & setup manager.
    smokeCron?.stop();
    clearInterval(reminderInterval);
    clearInterval(humanTimeoutInterval);
    clearInterval(artifactRetentionInterval);
    retentionSweeper.stop();
    await workflowTriggerScheduler.dispose();
    await agentRunExecution.dispose(); // abort/SIGTERM/SIGKILL children + drain
    codingRegistry.closeAll(); // PTYs die with the children, not with the OS
    await productToolsMcp?.close();
    await workflowMcp?.close();
    await agentConfigMcp?.close();
    await sandboxProxy?.close();
    await larkBotRegistry.dispose();
    disposeSetupManager();
  }

  await seedDefaultTeamAndWorkflows({ config, agentSvc, codingAgentCatalog });

  // B4: one best-effort reconcile over every LIVE agent at boot — worktrees
  // and bridged configs refresh without waiting for the first PATCH (replaces
  // any stale static-bearer .mcp.json from older installs). Failures warn per
  // agent; startup proceeds. Archived rows are skipped for the same reason the
  // bot pull-up skips them: `getById` refuses archived agents, so listing them
  // only produced a warning per ghost on every boot.
  for (const agent of await agentSvc.list()) {
    try {
      await reconcileAgent.fn(agent.id);
    } catch (err) {
      console.warn(`[bootstrap] startup reconcile failed for ${agent.id}:`, err);
    }
  }

  return {
    featureSet,
    proposalSvc,
    agentRunService,
    agentRunExecution,
    productTools,
    workflowExecutionService,
    prepare,
    start,
    dispose,
  };
}
