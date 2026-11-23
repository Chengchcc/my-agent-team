import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { resolveModelAlias } from "@chengchenccc/ai";
import type { EmbeddingProvider } from "@chengchenccc/embedding";
import type { AskQuestionInput } from "@chengchenccc/message";
import { extractText, type Message, serializeMessageRevision } from "@chengchenccc/message";
import type { WorkflowDefinition } from "@chengchenccc/workflow";
import type { FeatureSet } from "../app.js";
import { createAgentSvc } from "../features/agent/agent-compose.js";
import { createAgentIdentityStore, identityTextOf } from "../features/agent/agent-identity.js";
import { FRONT_DESK_DISABLED_TOOLS } from "../features/agent/front-desk-tools.js";
import {
  AgentBusyError,
  agentModelRef,
  agentRoutes,
  createAgentConfigMcpServer,
  createModelCatalogCheck,
} from "../features/agent/index.js";
import { FRONT_DESK_DISCIPLINE } from "../features/agent/prompt-front-desk.js";
import {
  bridgeWorktreeRoot,
  type McpServerEntry,
  reconcileAgentResources,
  writeMcpConfig,
  writeProductToolsManifest,
} from "../features/agent/workspace-bridge.js";
import {
  createAgentContextService,
  sqliteAgentContextAdapter,
} from "../features/agent-context/index.js";
import type { LedgerMessageResolver } from "../features/agent-context/ports.js";
import { AcpBackend } from "../features/agent-run/acp/acp-backend.js";
import { probeHarnessCatalog } from "../features/agent-run/acp/harness-catalog.js";
import { AcpModelCatalog } from "../features/agent-run/acp/model-catalog.js";
import { ACP_AGENTS } from "../features/agent-run/acp/registry.js";
import { deliveryNoteOf, producedByEvent } from "../features/agent-run/delivery-gate.js";
import { pendingActionId } from "../features/agent-run/domain.js";
import { finalAnswerMessage } from "../features/agent-run/execution-input.js";
import {
  agentRunRoutes,
  buildHistoryTools,
  createAgentRunExecutionService,
  createAgentRunService,
  createBudgetGate,
  resolveRunWorkspace,
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
  chatUri,
  createAhpChatWriter,
  createAhpHost,
  createAhpStateSource,
  type RunTurnContext,
} from "../features/ahp/index.js";
import {
  artifactRoutes,
  createArtifactFsAdapter,
  createArtifactService,
} from "../features/artifact/index.js";
import { authRoutes, createPasswordService, MIN_PASSWORD_LENGTH } from "../features/auth/index.js";
import {
  type CodingTarget,
  codingRoutes,
  createTerminalRegistry,
} from "../features/coding/index.js";
import { loadPersistedTerminals, savePersistedTerminals } from "../features/coding/persist.js";
import { listTaskWorktrees, validateWorktreePath } from "../features/coding/task-worktrees.js";
import { createConversationFeature } from "../features/conversation/conversation-compose.js";
import {
  conversationRoutes,
  createConversationMembers,
  deriveConversationTitle,
  firstUserText,
  sqliteConversationAdapter,
} from "../features/conversation/index.js";
import { createConfiguredSummarizer } from "../features/conversation/summarize.js";
import { createEmbeddingClient } from "../features/embedding-client.js";
import {
  CliSetupProvisioner,
  createLarkSetupStore,
  LarkSetupManager,
  probeCliSetupCapability,
} from "../features/lark-bot/index.js";
import {
  createMcpRuntimeStatusStore,
  createMcpService,
  fileMcpServerAdapter,
  mcpRoutes,
} from "../features/mcp/index.js";
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
  type AssessmentCall,
  createConfiguredAssessment,
} from "../features/proactive/assessment.js";
import { type AgentCard, frameAssessmentInput } from "../features/proactive/domain.js";
import {
  createProactiveService,
  proactiveRoutes,
  sqliteProactiveAdapter,
} from "../features/proactive/index.js";
import type { AssessmentGate } from "../features/proactive/service.js";
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
import {
  createProjectService,
  projectRoutes,
  sqliteProjectAdapter,
} from "../features/project/index.js";
import { pushProjectWorktree } from "../features/project/push.js";
import { ensureRequirementWorktree } from "../features/project/requirement-workspace.js";
import { createWorkspaceLockRegistry } from "../features/project/workspace-lock.js";
import {
  createTaskWorktree,
  ensureMirror,
  ensureWorktree,
  removeTaskWorktree,
  removeWorktree,
} from "../features/project/worktree.js";
import { createWorktreeOps } from "../features/project/worktree-ops.js";
import {
  createProposalService,
  type ProposalService,
  proposalRoutes,
  sqliteProposalAdapter,
} from "../features/proposal/index.js";
import { createProviderService, providerRoutes } from "../features/provider/index.js";
import { createMemoryRecall } from "../features/recall/memory-recall.js";
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
import { createRuntimeOpsService, opsRoutes } from "../features/runtime-ops/index.js";
import { settingsRoutes } from "../features/settings/index.js";
import type { SkillPackRow } from "../features/skill-pack/index.js";
import {
  checkUpstream,
  createSkillPackService as createSkillPackServiceFn,
  installPath,
  runInstall,
  runSync,
  seedSkillPacks,
  setSkillPackPort,
  skillPackRoutes,
  sqliteSkillPackAdapter,
} from "../features/skill-pack/index.js";
import { createFsWikiStore, createWikiService, wikiRoutes } from "../features/wiki/index.js";
import {
  createNodeRunners,
  createWorkflowExecutionService,
  createWorkflowMcpServer,
  createWorkflowTriggerScheduler,
  sqliteWorkflowExecutionAdapter,
  workflowRoutes,
} from "../features/workflow/index.js";
import { createWorkspaceService } from "../features/workspace/service.js";
import { startAllowlistProxy } from "../infra/allowlist-proxy.js";
import { ConflictError, NotFoundError } from "../infra/domain-errors.js";
import { ulid } from "../infra/ids.js";
import { resolveOmaAcpArgv, resolveOmaCommand } from "../infra/oma-command.js";
import { sseUrlEndpoint } from "../infra/sse-url.js";
import type { BackendServices } from "./services.js";

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
  workflowExecutionService: ReturnType<typeof createWorkflowExecutionService>;

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
            ctx.sourceKind === "zip" && ctx.sourceUrl
              ? Buffer.from(ctx.sourceUrl, "base64")
              : undefined,
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
    onAgentUpdate: (agentId: string, prevProjects: string[]) =>
      reconcileAgent.fn(agentId, prevProjects),
    assertNoActiveRun: (agentId: string) => busyGuard.check?.(agentId),
    // Tests inject a no-op: the real writer edits the operator's live
    // `~/.lark-cli/config.json`, and a test suite must never do that.
    ...(services.larkProfileInit ? { profileInit: services.larkProfileInit } : {}),
  });

  /** ADR 0074: the seeded identities. A SOUL.md is the agent's own persona —
   *  the product rules arrive separately as the front-desk discipline, and
   *  duplicating them here would make one of the two go stale. Written only
   *  when absent: a boot must never revert an operator's edit. */
  const SEED_SOULS: Record<string, string> = {
    default: `# Personal Agent

你是一个人长期依赖的私人助理，不是工具箱。

## 你怎么工作

- 你管的是注意力：先弄清对方真正想要什么，再决定「我答 / 我安排 / 我派人」。
- 动手的活交给团队：你负责说清规格、盯住结果、把结论说成人话。
- 你不假装做完。没验证就说没验证，卡住就说卡在哪、需要谁决定。
- 空闲时你整理知识：这个人在意什么、决定过什么、为什么——记进 wiki，标好来源。

## 你的边界

- 你没有写文件和执行命令的能力，这不是缺陷，是分工。
- 你改变不了授权与配置；需要改，就请人来做。`,
    coder: `# Coder

你是一个工程师。你的作品是改动本身和可复现的验证。

## 你怎么工作

- 先读再改：看不懂的代码不猜着改。
- 改完就跑：验证结果贴命令和输出，不用形容词代替证据。
- 报告写「改了什么 / 怎么验证的 / 还有什么风险」，三句话能说完就别写三段。

## 你的边界

- 只在自己的工作区里动手；工作区外的东西只读。
- 需要人拍板的事（不可逆操作、缺信息、规格矛盾）就停下来问，不硬猜。`,
    researcher: `# Researcher

你把「不确定」变成「可判断」。

## 你怎么工作

- 每个结论标来源；区分「资料这么说」和「我认为」。
- 比较方案时先给取舍维度（成本、风险、可逆性），再给倾向，最后说清前提。
- 找不到就说找不到；不用看起来合理的推测填空。

## 你的边界

- 不做实现，也不替人拍板；你的交付是判断依据。`,
  };

  async function seedSoul(agentId: string, soul: string): Promise<void> {
    if (soul === "") return;
    const agent = await agentSvc.getById(agentId);
    mkdirSync(agent.workspacePath, { recursive: true });
    const file = join(agent.workspacePath, "SOUL.md");
    // The workspace seeder writes a TEMPLATE (# SOUL + "describe this agent
    // here"); that is not an identity, so it is replaceable. Anything a person
    // actually wrote is not.
    const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (identityTextOf(existing) !== null) return;
    writeFileSync(file, `${soul.trimEnd()}\n`, "utf8");
  }

  async function ensureAgent(
    id: string,
    name: string,
    options: { harness: string; model?: string; description?: string; role?: "worker" },
  ) {
    try {
      await agentSvc.getById(id);
    } catch {
      await agentSvc.create({
        id,
        name,
        harness: options.harness,
        ...(options.model ? { model: options.model } : {}),
        permissionMode: "auto",
        ...(options.description ? { description: options.description } : {}),
        ...(options.role ? { role: options.role } : {}),
      });
    }
  }

  /** Seed model + provider derive from the live catalog (single source of
   *  truth) — catalog evolution changes the default without touching this
   *  file. Picks the FIRST available model across all providers (the user's
   *  configured provider keys determine which appear). When no provider has
   *  a key yet (clean machine), seeds a placeholder so agents still exist
   *  and get configured later in the UI. */
  async function defaultSeedModel(): Promise<{ harness: string; model: string }> {
    try {
      const catalog = await codingAgentCatalog.list();
      const first = catalog.models.find((m) => m.available !== false);
      if (first) {
        // oma's ACP server catalogs the provider models themselves, so the
        // catalog id is already exactly what that harness runs.
        return { harness: "oma", model: first.id };
      }
    } catch (err) {
      console.warn(
        "[bootstrap] seed model catalog failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    // ponytail: no provider key yet. Agents still exist with
    // identity/memory/skills; "" lets the harness run its own default.
    return { harness: "oma", model: "" };
  }

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
      const packs = await skillPackPort.listForAgent(agentId);
      const packRoots = packs
        .filter((p) => p.status === "ready")
        .map((p) => installPath(config.dataDir, p.id));
      // The builtin skills (capability docs: workflow authoring, loop
      // workflow) are ALWAYS available - assigned packs add on top.
      const skillRoots = [config.builtinSkillsDir, ...packRoots];
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
      const withInterrupted = interruptedBlock
        ? `${systemPrompt}\n\n${interruptedBlock}`
        : systemPrompt;
      const result: {
        systemPrompt?: string;
        skillRoots?: readonly string[];
        permissionMode?: string;
        toolPolicy?: { deny: string[]; allow: string[]; denyCommands?: string[] };
      } = {};
      if (withInterrupted) result.systemPrompt = withInterrupted;
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
  // ADR 0047: validated member ops, shared by the routes, the ambient seam
  // and the dispatch tool (one roster authority).
  const conversationMembers = createConversationMembers({
    port: convPort,
    agentExists: (id: string) => agentSvc.exists(id),
  });
  // ADR 0046: ambient rules evaluate at the conversation observe seam. The
  // service owns the event ledger; rules themselves live in agent config.
  // ADR 0048: the semantic net under the rules — gate read per message, the
  // model caller rebuilt only when the configured spec changes, promotion
  // dereferences conv at request time (wired below, same late-bound trick
  // as the dispatch tool).
  const readAssessmentGate = (): AssessmentGate => {
    const stored = settingsSvc.get<{ mode?: string; model?: string }>("proactiveAssessment");
    const mode = stored?.mode;
    if (mode !== "observe" && mode !== "auto") return { mode: "off" };
    return { mode, model: stored?.model };
  };
  let cachedAssessment: { spec: string; call: AssessmentCall } | undefined;
  const assessmentCallOf = (spec: string): AssessmentCall | undefined => {
    if (cachedAssessment?.spec === spec) return cachedAssessment.call;
    const call = createConfiguredAssessment(spec, (id) => providerSvc.credentialFor(id));
    if (!call) return undefined;
    cachedAssessment = { spec, call };
    return call;
  };
  /** The enabled, non-archived roster as capability cards — the one source
   *  both the assessment and team_list read. */
  const rosterCards = async (): Promise<AgentCard[]> => {
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
  const proactiveSvc = createProactiveService({
    port: sqliteProactiveAdapter(db),
    agentSvc,
    assessmentGate: readAssessmentGate,
    assessmentCall: (input) => {
      const gate = readAssessmentGate();
      const spec = gate.model;
      if (spec === undefined) {
        return Promise.reject(new Error("assessment mode is on but no model is configured"));
      }
      const call = assessmentCallOf(spec);
      if (call === undefined) {
        return Promise.reject(new Error(`assessment model spec invalid: ${spec}`));
      }
      return call(input);
    },
    listCards: rosterCards,
    promote: async ({ conversationId, agentId, toAgentId, senderMemberId, instruction, text }) => {
      if (toAgentId !== agentId) {
        await conversationMembers.add(conversationId, toAgentId);
      }
      await conv.convSvc.postMessage({
        conversationId,
        senderMemberId,
        addressedTo: [toAgentId],
        content: frameAssessmentInput(instruction, text, senderMemberId),
        mode: "normal",
        authorization: "ambient:assessment",
      });
    },
  });
  const conv = createConversationFeature({
    convPort,

    agentSvc,
    agentRunService,
    evaluateAmbient: (input) => proactiveSvc.evaluate(input),
    addConversationMember: async (conversationId, agentId) => {
      await conversationMembers.add(conversationId, agentId);
    },
    isWorkerAgent: async (id: string) => {
      try {
        const row = await agentSvc.getById(id);
        return row.config.role === "worker";
      } catch {
        return false;
      }
    },
    agentNameOf: async (id: string) => {
      try {
        const row = await agentSvc.getById(id);
        return row.config.name;
      } catch {
        return undefined;
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
      return productTools.resolveAsk(ask.runId, ask.callId, {
        answers: [{ id: ask.questionId, selectedValues: [], freeText: text }],
      });
    },
  });

  // Artifact storage (shared across agents, workspaces, workflows).
  const artifactService = createArtifactService(
    createArtifactFsAdapter(join(config.dataDir, "artifacts")),
  );

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
    deliver: async ({ conversationId, text, author }) => {
      await conv.convSvc.postMessage({
        conversationId,
        content: `${REMINDER_BANNER_PREFIX}${text}`,
        mode: "normal",
        // ADR 0047: no human authored this run — the reminder tick did.
        authorization: "system",
        ...(author ? { addressedTo: [author] } : {}),
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
      const res = await agentRunPort.enqueueAndAcquire({
        conversationId: input.conversationId,
        agentId: input.agentId,
        branchId: input.branchId,
        mode: "steer",
        message: input.message,
        inputIdempotencyKey: `result:${input.parentRunId}`,
        runIdempotencyKey: `result:${input.parentRunId}`,
        deliveryIdempotencyKey: `result:${input.parentRunId}`,
        defaultModel: input.defaultModel,
        configRevision: input.configRevision,
        expectedRevision: input.configRevision,
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
        addressedTo: [...input.addressedTo],
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
        addressedTo: [frontDesk],
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
      addressedTo: [owner.agentId],
      content: [
        `【请求】${workerName} 需要你决定：${detail}`,
        `用 answer_worker_request(run_id="${run.runId}", call_id="${input.callId}", evidence=[...]) 回答；`,
        "答不了（不可逆操作 / 超出授权 / 验收 / 无证据）就升级给人。",
      ].join("\n"),
    });
  }

  const productTools = createProductToolsService({
    runPort: agentRunPort,
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
      if (action === null || action.status !== "pending") {
        return { ok: false as const, error: `request ${callId} is no longer pending` };
      }
      if (action.owner !== `agent:${agentId}`) {
        return {
          ok: false as const,
          error: `request ${callId} is owned by ${action.owner ?? "user"}, not you`,
        };
      }
      if (action.kind === "approval") {
        if (decision === undefined) {
          return { ok: false as const, error: "an approval needs decision: allow | deny" };
        }
        await agentRunExecution.resolveApproval(runId, callId, decision);
      } else {
        if (answer === undefined) {
          return { ok: false as const, error: "an ask needs answer" };
        }
        const woke = productTools.resolveAsk(
          runId,
          callId,
          answer as Parameters<typeof productTools.resolveAsk>[2],
        );
        if (!woke) {
          return { ok: false as const, error: `ask ${callId} has no live resolver` };
        }
      }
      await agentRunPort.markActionAnswered?.(actionId, `agent:${agentId}`, evidence);
      return { ok: true as const };
    },
    onRequestCreated: (input) => {
      void surfaceRequest(input).catch((err: unknown) => {
        console.error(
          `[bootstrap] request notice failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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
          ...(process.env.PROJECT_PUSH_TOKEN !== undefined
            ? { token: process.env.PROJECT_PUSH_TOKEN }
            : {}),
          ...(named.defaultBranch !== null ? { defaultBranch: named.defaultBranch } : {}),
          ...(agent.config.name ? { agent: agent.config.name } : {}),
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
    // ADR 0074: project registry, dereferenced at request time (projectSvc is
    // assembled later in this function, like the other late bindings here).
    projects: {
      list: () =>
        projectSvc.list().map((p) => ({
          projectId: p.projectId,
          name: p.name,
          repoUrl: p.repoUrl ?? null,
        })),
    },
    // ADR 0074 S4: what the team already knows rides in the brief.
    wikiRecall: (text) =>
      wikiSvc.query({ text, limit: 3 }).map((h) => ({ path: h.path, title: h.title })),
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
        const item = requirementSvc.resolveForDispatch({
          ...(input.requirementId !== undefined ? { requirementId: input.requirementId } : {}),
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
        let requirementId = workspaceSvc.currentRequirementOf(conversationId);
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
        addressedTo: [toAgentId],
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
      // ledger-only (addressedTo: []), and carries the child's id so the room
      // can open it.
      const workerName =
        (await agentSvc.getById(toAgentId).catch(() => null))?.config.name ?? toAgentId;
      const head = instruction.length > 80 ? `${instruction.slice(0, 80)}…` : instruction;
      await conv.convSvc.postMessage({
        conversationId,
        senderMemberId: fromAgentId,
        addressedTo: [],
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
    // ADR 0052 handback: the worker's own run is the parent; the dispatcher
    // is woken with the reason, in the same room, under its own authority.
    handback: async ({ fromAgentId, toAgentId, conversationId, runId, reason, suggestion }) => {
      const posted = await conv.convSvc.postMessage({
        conversationId,
        senderMemberId: fromAgentId,
        addressedTo: [toAgentId],
        content: frameHandbackInput(fromAgentId, reason, suggestion),
        mode: "normal",
        authorization: `handback:${fromAgentId}`,
        parentRunId: runId,
      });
      const first = posted.triggeredRuns.find((entry) => entry.agentId === toAgentId);
      return { runId: first?.runId ?? "", queued: first?.queued ?? false };
    },
    // ADR 0059 D6: report goes upward through the same closure the terminal
    // state uses; progress never wakes, attention/answer do.
    notifyParent: async ({ fromAgentId, conversationId, runId, purpose, text, verification }) =>
      notifyDispatcher({
        fromAgentId,
        conversationId,
        runId,
        text: frameReportInput(fromAgentId, purpose, text, verification),
        wake: purpose !== "progress",
      }),
    // ADR 0065: the product's only memory writer. It appends to the SAME file
    // `learn` writes (learned.md, `- [YYYY-MM-DD] fact`), so the standalone
    // backfill picks it up unchanged. The product never writes the vector
    // store: that store's dedup/embedding semantics belong to its owner.
    remember: async ({ agentId, text }) => {
      const agent = await agentSvc.getById(agentId).catch(() => null);
      const root = agent?.workspacePath;
      if (!root) return { saved: false, reason: `agent ${agentId} has no workspace` };
      const dir = join(root, ".oma", "memory");
      // ADR 0065 amendment: the product keeps its OWN memory file. learned.md
      // is the standalone `learn` file, and syncing it to the vector store is
      // a standalone-only step - so a product write there would never be
      // readable (live-proven 2026-11-18). This file is written only by a
      // human-authorized run and read directly by the backend recall.
      const file = join(dir, "product.md");
      const line = `- [${new Date().toISOString().slice(0, 10)}] ${text.replace(/\s+/g, " ")}`;
      try {
        const existing = existsSync(file) ? await Bun.file(file).text() : "";
        // Same lesson twice is one lesson: compare the fact, not the date
        // prefix, so re-asking on another day does not duplicate it.
        const already = existing
          .split("\n")
          .some((row) => row.replace(/^-\s*\[\d{4}-\d{2}-\d{2}\]\s*/, "").trim() === text);
        if (already) return { saved: true, reason: "already remembered" };
        mkdirSync(dir, { recursive: true });
        const block = [
          existing.trim() === "" ? "# Learned\n" : existing.replace(/\s+$/, ""),
          "",
          line,
          "",
        ].join("\n");
        await Bun.write(file, block);
        return { saved: true };
      } catch (error) {
        return { saved: false, reason: (error as Error).message };
      }
    },
    // ADR 0059 D6: the two control verbs. Both resolve the worker's LIVE run
    // first and reject when there is none - queuing a "steer" for an idle
    // worker would silently become a task, which is dispatch's job.
    steerWorker: async ({ fromAgentId, conversationId, toAgentId, runId, callId, message }) => {
      const active = (
        await agentRunPort.listActiveRunsForConversations([conversationId]).catch(() => [])
      ).find((candidate) => candidate.agentId === toAgentId);
      if (!active) {
        return {
          ok: false,
          error: `${toAgentId} has no running task in this conversation; dispatch a new task instead of steering`,
        };
      }
      const text = `（${fromAgentId} 转达，优先于原任务）\n${message}`;
      const enqueued = await agentRunPort.enqueueAndAcquire({
        conversationId,
        agentId: toAgentId,
        branchId: active.branchId,
        mode: "steer",
        message: { role: "user", text },
        inputIdempotencyKey: `steer:${runId}:${callId}`,
        runIdempotencyKey: `steer:${runId}:${callId}`,
        deliveryIdempotencyKey: `steer:${runId}:${callId}`,
        defaultModel: active.modelRef,
        configRevision: active.configRevision,
        expectedRevision: active.configRevision,
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
      const active = (
        await agentRunPort.listActiveRunsForConversations([conversationId]).catch(() => [])
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
          addressedTo: [],
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
  // chat and the agentic-workflow-dsl skill.
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
      // agent_create goes through the SAME service as POST /api/agents, so
      // the workspace, agent.yml, row and onCreate (builtin pack + bridge
      // reconcile) all happen. A file write from the agent could not: the
      // sandbox stops it and a bare workspace dir is invisible to list().
      createAgent: async (input) => {
        const row = await agentSvc.create(input);
        return { id: row.id };
      },
      proposals: proposalSvc,
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
          text: frameResultInput(run.agentId, "failed", input.error),
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
            run.agentId,
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
  // Config-time (backendKind, model) consistency (see model-check.ts).
  const modelKnownForBackend = createModelCatalogCheck({ backends });
  const mcpRuntimeStatus = createMcpRuntimeStatusStore();
  /** The product read behind a run's turn. The writer owns the per-run caching and the ordering;
   *  this is the only part that knows about ports. */
  const readRunTurn = async (runId: string): Promise<RunTurnContext | null> => {
    const run = await agentRunPort.getRun(runId).catch(() => null);
    if (!run) return null;
    const inputs = await agentRunPort.listInputs(run.branchId).catch(() => []);
    const input = inputs.find((candidate) => candidate.runId === runId);
    return {
      conversationId: run.conversationId,
      inputText: input?.message.text ?? "",
      ...(input?.message.id === undefined ? {} : { messageId: input.message.id }),
      startedAt: new Date(run.createdAt).toISOString(),
      status: run.status,
    };
  };

  /** The chat channel's writer (ADR 0040 decision 4): live events as actions, a settled turn stated
   *  from the projection, and the two announcements. `ahpHost`/`ahpSource` are declared below, but
   *  every use of them sits inside a closure that only runs once the stack is up. */
  const chatWriter = createAhpChatWriter({
    dispatch: (uri, action) => ahpHost.server.dispatch(uri, action),
    invalidate: (uri) => ahpHost.server.invalidate(uri),
    // #65 output side: a tool-produced image's bytes exist only on the event,
    // so they land in the artifact store and the surfaces get a reference.
    saveImage: async ({ runId, conversationId, mediaType, base64 }) => {
      const ext =
        mediaType === "image/png"
          ? "png"
          : mediaType === "image/jpeg"
            ? "jpg"
            : mediaType === "image/gif"
              ? "gif"
              : "webp";
      const meta = await artifactService.upload({
        folder: `tool-images/${conversationId}`,
        filename: `${runId}-${Date.now()}.${ext}`,
        content: base64,
        encoding: "base64",
        source: { runId, conversationId },
      });
      return { uri: meta.url, contentType: meta.mimeType, size: meta.size };
    },
    projectedTurn: async (conversationId, turnId) => {
      const chat = await ahpSource.chat(chatUri(conversationId)).catch(() => null);
      return chat?.turns.find((candidate) => candidate.id === turnId) ?? null;
    },
    readRunTurnContext: readRunTurn,
  });

  /** Where a conversation's runs work: the Agent's workspace, its project worktree, or the
   *  fallback root. The run dispatch lets a mis-attached project throw (that is a real failure);
   *  the AHP session read treats the same failure as "nothing to show". */
  // ADR 0077: the requirement's checkout, materialized on first use. The
  // agent's project binding is a capability (who may be dispatched) and never
  // a directory — one agent owning one copy is what serialized two tasks.
  const workspaceSvc = createWorkspaceService({
    db,
    idGen: ulid,
    materialize: async ({ projectId, requirementId }) => {
      const project = projectSvc.getById(projectId);
      if (!project?.repoUrl) return null;
      const wp = {
        projectId: project.projectId,
        repoUrl: project.repoUrl,
        defaultBranch: project.defaultBranch,
      };
      const mirror = await ensureMirror(config.dataDir, wp);
      return ensureRequirementWorktree({
        mirrorPath: mirror,
        workspacesRoot: join(config.dataDir, "workspaces"),
        requirementId,
        projectId,
        defaultBranch: project.defaultBranch,
      });
    },
  });

  /** The room's current requirement and its OPEN checkout for a project, or
   *  nulls. Read-only. */
  const checkoutOf = (
    conversationId: string,
  ): {
    requirementId: string | null;
    projectId: string | null;
    checkout: { path: string } | null;
  } => {
    const convRow = conv.convPort.getConversation(conversationId);
    const requirementId = workspaceSvc.currentRequirementOf(conversationId);
    const requirementProject =
      requirementId === null
        ? null
        : (requirementSvc.get(requirementId)?.requirement.projectId ?? null);
    const projectId = convRow?.projectId ?? requirementProject;
    const checkout =
      requirementId !== null && projectId !== null
        ? workspaceSvc.findForRequirement({ requirementId, projectId })
        : null;
    return { requirementId, projectId, checkout };
  };

  /** Read-only lookup for readers (chat state, memory recall). It never opens
   *  a requirement: a read must not write. A project room with no checkout yet
   *  reads from the agent's own directory. */
  const peekWorkspaceFor = async (input: {
    conversationId: string;
    agentId?: string | null;
  }): Promise<{ root: string; access: "read_write" }> => {
    const agent = input.agentId ? await agentSvc.getById(input.agentId).catch(() => null) : null;
    const { projectId, checkout } = checkoutOf(input.conversationId);
    return resolveRunWorkspace({
      agentId: input.agentId ?? null,
      agentWorkspacePath: agent?.workspacePath ?? null,
      fallbackRoot: config.workspaceRoot,
      // No checkout → not a project room as far as the resolver is concerned.
      conversationProjectId: checkout === null ? null : projectId,
      requirementWorkspacePath: checkout?.path ?? null,
    });
  };

  /** The workspace a RUN works in. A project room with no requirement gets one
   *  NOW — opened by the product and visible in /requirements (ADR 0077): the
   *  alternative is a first message that fails because it has nowhere to work.
   *  A human room names its requirement after the room; a dispatched room
   *  already points at the dispatcher's requirement. */
  const workspaceForRun = async (input: {
    conversationId: string;
    agentId?: string | null;
  }): Promise<{ root: string; access: "read_write" }> => {
    const agent = input.agentId ? await agentSvc.getById(input.agentId).catch(() => null) : null;
    const convRow = conv.convPort.getConversation(input.conversationId);
    let { requirementId, projectId } = checkoutOf(input.conversationId);
    if (projectId !== null && requirementId === null) {
      const project = projectSvc.getById(projectId);
      const title =
        (convRow?.title ?? "").trim().slice(0, 80) ||
        (project ? `${project.name} — work opened from this room` : "Work opened from this room");
      const opened = requirementSvc.create({
        title,
        goal: "Opened by the product when work started in this room; refine the goal here.",
        projectId,
        originConversationId: input.conversationId,
        createdByAgentId: input.agentId ?? null,
      });
      requirementId = opened.requirementId;
      workspaceSvc.attachConversation({ conversationId: input.conversationId, requirementId });
      console.log(
        `[workspace] opened requirement ${requirementId} for room ${input.conversationId} (project ${projectId})`,
      );
    }
    // The checkout is where WORKERS work. A front-desk run routes and then
    // holds for the worker's result — if it also took the checkout, it would
    // hold the workspace lock the worker needs, and the two would wait on each
    // other forever (measured 2026-11-23: 0 tool calls in 13 minutes). The
    // front desk stays in its own directory; it opened the requirement above
    // and that is its whole part in it.
    const isWorker = agent?.config.role === "worker";
    const checkout =
      isWorker && requirementId !== null && projectId !== null
        ? await workspaceSvc.ensureForRequirement({ requirementId, projectId })
        : null;
    return resolveRunWorkspace({
      agentId: input.agentId ?? null,
      agentWorkspacePath: agent?.workspacePath ?? null,
      fallbackRoot: config.workspaceRoot,
      // A front desk in a project room is not "a project run": it has no
      // checkout and must not be refused for lacking one.
      conversationProjectId: isWorker ? projectId : null,
      requirementWorkspacePath: checkout?.path ?? null,
    });
  };

  // Catalog prices for usage and for the daily brake. Born at wiring time,
  // awaited by a request — the catch keeps a failed catalog call from taking
  // the process down (see the same pattern at the agent-run routes).
  const modelCostsSnapshot = (async () => {
    const map = new Map<
      string,
      { input: number; output: number; cacheRead: number; cacheWrite: number }
    >();
    for (const m of (await codingAgentCatalog.list()).models) {
      map.set(`oma/${resolveModelAlias(m.id)}`, m.cost);
    }
    return map;
  })().catch((err) => {
    console.warn("[bootstrap] model cost catalog failed:", err);
    return new Map<
      string,
      { input: number; output: number; cacheRead: number; cacheWrite: number }
    >();
  });

  const budgetGate = createBudgetGate({
    db,
    modelCosts: modelCostsSnapshot,
    getSetting: (key) => settingsSvc.get(key),
  });

  // The vector voice needs an embedding model; without one the FTS voice still
  // answers (degrades, never breaks - the store's own contract).
  const embeddingProviderForRecall = (): EmbeddingProvider | null => {
    if (!config.embeddingModel || !config.embeddingBaseUrl) return null;
    const client = createEmbeddingClient({
      model: config.embeddingModel,
      baseUrl: config.embeddingBaseUrl,
    });
    return {
      model: config.embeddingModel,
      dim: 0,
      embedDocuments: (texts) => client.embed([...texts]),
      embedQuery: async (text) => {
        const [vector] = await client.embed([text]);
        return vector ?? [];
      },
    };
  };

  const memoryRecall = createMemoryRecall({
    workspaceOf: async (conversationId) => {
      const convRow = conv.convPort.getConversation(conversationId);
      if (!convRow?.agentId) return null;
      const ws = await peekWorkspaceFor({
        conversationId,
        agentId: convRow.agentId,
      }).catch(() => null);
      return ws?.root ?? null;
    },
    embedding: embeddingProviderForRecall(),
  });

  const agentRunExecution = createAgentRunExecutionService({
    budgetGate,
    // ADR 0075: a request just parked - surface it to its owner (this closure
    // is defined above and dereferences late bindings at request time).
    onRequestCreated: (input) => {
      void surfaceRequest(input).catch((err: unknown) => {
        console.error(
          `[bootstrap] request notice failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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
    resolveWorkspace: ({ conversationId, agentId }) => workspaceForRun({ conversationId, agentId }),
    // ADR 0064: the front desk's long-term memory, read from its workspace.
    // Vector voice when an embedding model is configured; keyword-only
    // otherwise (narrower, never broken).
    searchMemory: (input) => memoryRecall.search(input),
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
    // re-written from source of truth immediately before every spawn.
    rewriteWorkspaceBridge: async (agentId, root) => {
      writeMcpConfig(root, await bridgeMcpServers(agentId));
      writeProductToolsManifest(root, productToolsManifest());
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
      // Dispatched runs live in their own rooms: the front desk's own
      // conversation never holds the producer (measured 2026-11-23 — the gate
      // stayed silent because it only looked at this room).
      const recent =
        (await agentRunPort
          .listDispatchedRuns?.(run.conversationId, 6 * 60 * 60_000)
          .catch(() => null)) ??
        (await agentRunPort
          .listRecentRunsForConversations([run.conversationId], 6 * 60 * 60_000)
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
            run.agentId,
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
  injectSteer.fn = (branchId: string, input: { inputId: string; message: Message }) =>
    agentRunExecution.injectSteer(branchId, input);
  isLive.fn = (runId: string) => agentRunExecution.isLive(runId);
  isInflight.fn = (runId: string) => agentRunExecution.isInflight(runId);
  abortStaleRun.fn = (runId: string) => agentRunExecution.abortStaleRun(runId);

  // ─── Lark setup ────────────────────────────────────────────
  let setupManager: LarkSetupManager | undefined;
  function getSetupManager(provisioner = new CliSetupProvisioner()): LarkSetupManager {
    if (!setupManager) {
      // Persisted: a restart must not lose a half-finished authorization, and
      // an expired one has to stay readable for the wizard to explain it.
      const setupStore = createLarkSetupStore(db);
      setupManager = new LarkSetupManager(
        provisioner,
        async (session) => {
          await agentSvc.update(session.agentId, {
            lark: { enabled: true, botDisplayName: session.botDisplayName ?? undefined },
          });
          await larkBotRegistry.ensureLarkBot(
            session.agentId,
            session.botDisplayName,
            session.profileRef,
          );
          console.log(
            `[lark-setup] completed for ${session.agentId}, profile=${session.profileRef}`,
          );
        },
        setupStore,
      );
    }
    return setupManager;
  }

  // ─── Runtime Ops (surface-health audit only) ───────────────

  /** Whether `POST .../lark/setup` can run here. The real check spawns
   *  `lark-cli … --help`, too heavy for a GET the wizard polls, so the
   *  answer is cached for a minute — long enough to be useful, short enough
   *  that installing the CLI shows up without a restart. */
  const CLI_PROBE_TTL_MS = 60_000;
  let cliCapability: { at: number; available: boolean } | null = null;
  const setupAvailable = async (): Promise<boolean> => {
    if (cliCapability && Date.now() - cliCapability.at < CLI_PROBE_TTL_MS) {
      return cliCapability.available;
    }
    const available = await probeCliSetupCapability().catch(() => false);
    cliCapability = { at: Date.now(), available };
    return available;
  };

  const agentNames = new Map<string, string>();
  {
    const rows = await agentSvc.list(true);
    for (const r of rows) agentNames.set(r.id, r.config.name);
  }

  const opsSvc = createRuntimeOpsService({
    opsStore: services.opsStore,
    getAgentName: (agentId: string) => agentNames.get(agentId),
    dbPath: `${config.dataDir}/backend.db`,
  });

  /** Inputs of the Lark wizard read model. Assembled here because this is
   *  the only scope that holds all four sources at once: the agent config,
   *  the setup session, the bot registry, and the heartbeat store. */
  const larkSurfaceFactsOf = async (agentId: string) => {
    const agent = await agentSvc.getById(agentId).catch(() => null);
    if (!agent) return null;
    const lk = agent.config.lark;
    const surface = opsSvc.getAgentRuntime(agentId).surfaces.lark;
    const session = setupManager?.getByAgentId(agentId);
    const counters = (surface?.counters ?? {}) as Record<string, unknown>;
    const pending = counters.pendingDeliveries;
    const runtime = {
      registryStatus: larkBotRegistry.statusOf(agentId),
      lastSeenAt: surface?.lastSeenAt ?? null,
      lastError: surface?.lastError ?? null,
      // The bot reports counters, not a queue length; absent means zero.
      pendingDeliveries: typeof pending === "number" ? pending : 0,
      setupAvailable: await setupAvailable(),
    };
    const setup = session
      ? {
          id: session.setupId,
          status: session.status,
          expiresAt: session.expiresAt,
          ...(session.brand ? { brand: session.brand } : {}),
          ...(session.error ? { error: session.error } : {}),
          ...(session.url ? { url: session.url } : {}),
        }
      : null;
    return {
      config: {
        enabled: lk.enabled,
        appId: lk.app_id !== "" ? lk.app_id : null,
        profileRef: lk.profile_ref !== "" ? lk.profile_ref : null,
        botDisplayName: lk.bot_display_name !== "" ? lk.bot_display_name : null,
        allowedSenders: lk.allowed_senders,
        ...(lk.group_policy ? { groupPolicy: lk.group_policy } : {}),
      },
      runtime,
      setup,
    };
  };

  // ─── Project ────────────────────────────────────────────────

  const projectPort = sqliteProjectAdapter(db);
  const projectSvc = createProjectService({
    port: projectPort,
    hasProjectBinding: (pid: string) => conv.convPort.hasProjectBinding?.(pid) ?? false,
    idGen: ulid,
    // Detach guard (ADR 0023): refuse deleting a project agents still
    // attach to. agentSvc.list returns rows carrying the materialized
    // config cache; includeArchived covers archived agents too.
    listAgentConfigs: async () =>
      (await agentSvc.list(true)).map((a) => ({
        id: a.id,
        projects: a.config.runtime_config.projects,
      })),
  });

  // ─── MCP ────────────────────────────────────────────────────

  const mcpSvcRaw = createMcpService({
    port: fileMcpServerAdapter(config.dataDir),
    mcpClientManager,
    runtimeStatus: mcpRuntimeStatus,
    agentExists: (id: string) => agentSvc.exists(id),
    getAgentMcpServers: async (agentId) => {
      const agent = await agentSvc.getById(agentId);
      return agent.config.runtime_config.mcp_servers.map((s) => ({
        serverId: s.server_id,
        enabled: s.enabled,
      }));
    },
    setAgentMcpServers: async (agentId, entries) => {
      await agentSvc.update(agentId, {
        mcpServers: entries.map((e) => ({ serverId: e.serverId, enabled: e.enabled })),
      });
    },
    idGen: ulid,
  });
  // Catalog mutations + assignment changes re-reconcile every affected
  // agent's workspace mcp.json (ADR 0022).
  const mcpSvc: ReturnType<typeof createMcpService> = {
    ...mcpSvcRaw,
    async create(input) {
      const row = await mcpSvcRaw.create(input);
      return row;
    },
    async update(serverId, input) {
      const row = await mcpSvcRaw.update(serverId, input);
      for (const agentId of await agentIdsWithMcpServer(serverId)) {
        await reconcileAgent.fn(agentId);
      }
      return row;
    },
    async delete(serverId) {
      const affected = await agentIdsWithMcpServer(serverId);
      await mcpSvcRaw.delete(serverId);
      for (const agentId of affected) await reconcileAgent.fn(agentId);
    },
    async setAgentServers(agentId, entries) {
      await mcpSvcRaw.setAgentServers(agentId, entries);
      await reconcileAgent.fn(agentId);
    },
  };
  async function agentIdsWithMcpServer(serverId: string): Promise<string[]> {
    // The catalog row exists before delete; agents are whoever assigned it.
    const all = await agentSvc.list();
    const ids: string[] = [];
    for (const agent of all) {
      if ((await mcpSvcRaw.listAssignments(agent.id)).some((a) => a.serverId === serverId)) {
        ids.push(agent.id);
      }
    }
    return ids;
  }

  /** H1: the ONE builder of the workspace mcp server list — used by
   *  reconcileAgent (config changes) AND the per-dispatch rewrite
   *  (rewriteWorkspaceBridge). Keeping a single author means an
   *  agent-tampered .mcp.json is always overwritten from this source of
   *  truth before the next spawn mounts it. */
  async function bridgeMcpServers(agentId: string): Promise<McpServerEntry[]> {
    const agent = await agentSvc.getById(agentId);
    return [
      ...(await mcpSvc.listForAgent(agentId)).map((s) => ({
        name: s.name,
        transport: s.transport,
        url: s.url,
        command: s.command,
        args: s.args ?? [],
        env: s.env ?? {},
        headers: s.headers ?? {},
      })),
      // The product-tools server (ledger access, ADR 0020) merges into
      // the SAME workspace .mcp.json — one config, one writer. Gated by
      // the per-server enabled set (ENABLED_MCP_SERVERS).
      ...(config.productToolsMcpUrl && enabledMcpServers.has("product-tools")
        ? [
            {
              name: "product-tools",
              transport: "sse" as const,
              // The SSE session endpoint is `<base>/sse` (the child's
              // SSEClientTransport GETs the url as-is; the bare base
              // 404s). sseUrlEndpoint appends only when needed.
              url: sseUrlEndpoint(config.productToolsMcpUrl),
              // ENV NAME, not the token: pi (bearerTokenEnv) and omp
              // (bearer_token_env_var) read this var at connect time;
              // claude expands the ${VAR} placeholder in headers. The
              // per-run bearer arrives via spawn env. File stays static.
              bearerTokenEnv: "PRODUCT_TOOLS_RUN_TOKEN",
              // An ask_question parks until a human answers — the call must
              // outlive the SDK's 60s default and the backend's own ask
              // deadline, or the question dies before it can be read.
              timeoutMs: config.askTimeoutMs + 60_000,
            },
          ]
        : []),
      // The workflow DSL server (per-server controlled): lets the chat
      // agent read/write the workflow file it is editing. Injected only
      // when enabled AND the server is live.
      ...(workflowMcp
        ? [
            {
              name: "workflow",
              transport: "sse" as const,
              // The Oma SSEClientTransport GETs this url as-is; the bare
              // base 404s, so point at the /sse endpoint directly.
              url: workflowMcp.url,
            },
          ]
        : []),
      // The agent-config server: lets the chat agent read/write an
      // agent's config, so the edit page's chat can propose changes.
      ...(agentConfigMcp
        ? [
            {
              name: "agent-config",
              transport: "sse" as const,
              url: agentConfigMcp.url,
            },
          ]
        : []),
    ];
  }

  /** The product-tools manifest (ADR 0003 decision 6) — single source for
   *  reconcile + the per-dispatch manifest rewrite. */
  function productToolsManifest(): readonly unknown[] {
    return config.productToolsMcpUrl
      ? [...buildHistoryTools(`sse:${sseUrlEndpoint(config.productToolsMcpUrl)}`)]
      : [];
  }

  reconcileAgent.fn = async (agentId: string, prevProjects?: string[]): Promise<void> => {
    try {
      const agent = await agentSvc.getById(agentId);
      // Detach cleanup (ADR 0023): projects removed since the previous
      // config get their worktree + branch removed.
      if (prevProjects) {
        const removed = prevProjects.filter(
          (pid) => !agent.config.runtime_config.projects.includes(pid),
        );
        for (const pid of removed) {
          const project = projectSvc.getById(pid);
          if (!project?.repoUrl) continue;
          try {
            const mirror = await ensureMirror(config.dataDir, {
              projectId: project.projectId,
              repoUrl: project.repoUrl,
              defaultBranch: project.defaultBranch,
            });
            await removeWorktree(
              mirror,
              agent.workspacePath,
              {
                projectId: project.projectId,
                repoUrl: project.repoUrl,
                defaultBranch: project.defaultBranch,
              },
              agentId,
            );
            // Task worktrees (ADR 0023's task axis) sit beside the main one
            // as projects/<projectId>.<slug>; a detach must take them too or
            // the checkout and its branch outlive the attachment. Dirty ones
            // are left in place and reported - never force-deleted.
            for (const task of listTaskWorktrees(project.projectId, [
              { id: agentId, workspacePath: agent.workspacePath },
            ])) {
              try {
                await removeTaskWorktree(
                  mirror,
                  agent.workspacePath,
                  {
                    projectId: project.projectId,
                    repoUrl: project.repoUrl,
                    defaultBranch: project.defaultBranch,
                  },
                  agentId,
                  task.slug,
                  // Never force on detach: losing uncommitted work silently is
                  // worse than a leftover the Coding surface can still see.
                  { force: false },
                );
              } catch (taskErr) {
                console.warn(
                  `[reconcile] task worktree ${project.projectId}.${task.slug} left in place for ${agentId}:`,
                  taskErr instanceof Error ? taskErr.message : String(taskErr),
                );
              }
            }
          } catch (err) {
            console.warn(`[reconcile] detach cleanup for ${agentId}/${pid} failed:`, err);
          }
        }
      }
      const packs = await skillPackPort.listForAgent(agentId);
      // ADR 0077: an agent no longer owns project checkouts. The checkout is
      // the requirement's (`<dataDir>/workspaces/<requirementId>/<projectId>`),
      // created when a dispatch needs it; `projects` on the agent stays what it
      // always was for the guard — who may be dispatched to which project.
      const extraRoots: string[] = [];
      reconcileAgentResources({
        extraRoots,
        workspacePath: agent.workspacePath,
        kind: agent.config.runtime_config.harness,
        skillPacks: packs
          .filter((p) => p.status === "ready")
          .map((p) => ({ id: p.id, source: installPath(config.dataDir, p.id) })),
        mcpServers: await bridgeMcpServers(agentId),
        productTools: productToolsManifest(),
      });
    } catch (err) {
      console.error(`[bridge] reconcile failed for ${agentId}:`, err);
    }
  };

  // ─── FeatureSet ─────────────────────────────────────────────

  // Worktree read/merge ops over the project mirrors (ADR 0023 P2).
  const worktreeOps = createWorktreeOps({
    dataDir: config.dataDir,
    projectPort,
    listAgentConfigs: async () =>
      (await agentSvc.list(true)).map((a) => ({
        id: a.id,
        workspacePath: a.workspacePath,
        projects: a.config.runtime_config.projects,
      })),
  });

  // ─── Coding page terminals (plan A: PTY registry, ADR on Coding page) ──

  const resolveCodingTarget = async (
    projectId: string | null | undefined,
    agentId: string,
    worktreePath?: string,
  ): Promise<CodingTarget> => {
    const agents = await agentSvc.list(true);
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) throw new NotFoundError("agent", agentId);
    // --- the pane's shell and oma line, for whichever directory we resolve ---
    const oma = resolveOmaCommand(config);
    const shQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const omaLaunchLine = [oma.executable, ...(oma.args ?? [])].map(shQuote).join(" ");
    const targetOf = (cwd: string, omaEnv?: Record<string, string | undefined>): CodingTarget => ({
      cwd,
      // ponytail: literal /bin/bash — env must flow through packages/config.
      shell: { executable: "/bin/bash", args: [], env: omaEnv ?? oma.env },
      omaLaunch: omaLaunchLine,
      omaPane: {
        executable: "/bin/bash",
        args: ["-c", `${omaLaunchLine} --continue; exec /bin/bash`],
        env: omaEnv ?? oma.env,
      },
    });
    // ADR 0073: no project = a terminal in the agent's OWN workspace, which is
    // where a room's worker runs. A conversation can open it without inventing
    // a project first.
    if (projectId === null || projectId === undefined) return targetOf(agent.workspacePath);
    if (!agent.config.runtime_config.projects.includes(projectId)) {
      throw new ConflictError(`agent ${agentId} has not attached project ${projectId}`);
    }
    const project = projectSvc.getById(projectId);
    if (!project?.repoUrl) {
      throw new NotFoundError("project", projectId);
    }
    const wtProject = {
      projectId: project.projectId,
      repoUrl: project.repoUrl,
      defaultBranch: project.defaultBranch,
    };
    // A task worktree is created explicitly; only the MAIN worktree
    // materializes on demand here. The validated path (prefix-checked
    // against this agent's namespace) wins when provided.
    const main = join(agent.workspacePath, "projects", projectId);
    const cwd = validateWorktreePath(agent.workspacePath, projectId, worktreePath) ?? main;
    if (cwd === main && !existsSync(main)) {
      // Normally the agent-update reconcile materialized it; first click
      // after a fresh deploy does it on demand (local mirror, bounded).
      const mirror = await ensureMirror(config.dataDir, wtProject);
      const wt = await ensureWorktree(mirror, agent.workspacePath, wtProject, agentId);
      if (!wt) {
        throw new ConflictError(`worktree slot occupied by a plain directory: ${main}`);
      }
    }
    if (cwd !== main && !existsSync(cwd)) {
      throw new NotFoundError("task worktree", cwd);
    }
    return targetOf(cwd);
  };

  const listCodingTaskWorktrees = (projectId: string) =>
    agentSvc.list(true).then((rows) =>
      listTaskWorktrees(
        projectId,
        rows.map((a) => ({ id: a.id, workspacePath: a.workspacePath })),
      ),
    );

  const createCodingTaskWorktree = async (projectId: string, agentId: string, slug: string) => {
    const target = await resolveCodingTarget(projectId, agentId); // validates attach + repo
    const project = projectSvc.getById(projectId);
    if (!project?.repoUrl) throw new NotFoundError("project", projectId);
    const agent = (await agentSvc.list(true)).find((a) => a.id === agentId);
    if (!agent) throw new NotFoundError("agent", agentId);
    const wtProject = {
      projectId: project.projectId,
      repoUrl: project.repoUrl,
      defaultBranch: project.defaultBranch,
    };
    const mirror = await ensureMirror(config.dataDir, wtProject);
    const path = await createTaskWorktree(mirror, agent.workspacePath, wtProject, agentId, slug);
    // MCP-only bridge: reconcileAgentResources treats skill/knowledge
    // lists as authoritative want-sets — passing empties would wipe the
    // main workspace's links (review round-2 P0).
    bridgeWorktreeRoot({
      root: path,
      mcpServers: await bridgeMcpServers(agentId),
      productTools: productToolsManifest(),
    });
    return { path, mainPath: target.cwd };
  };

  // Boot restore (P2): the membership snapshot survives restarts; entries
  // whose agent/project vanished are skipped (and pruned on next persist).
  // Fire-and-forget — a slow first-time mirror clone must not block boot.
  const codingStateFile = join(config.dataDir, "coding", "terminals.json");
  const codingRegistry = createTerminalRegistry({
    persist: (snapshot) => savePersistedTerminals(codingStateFile, snapshot),
  });
  void (async () => {
    for (const entry of loadPersistedTerminals(codingStateFile)) {
      try {
        const target = await resolveCodingTarget(entry.projectId, entry.agentId);
        const cwd = existsSync(entry.cwd) ? entry.cwd : target.cwd;
        codingRegistry.spawn({
          terminalId: entry.terminalId,
          projectId: entry.projectId,
          agentId: entry.agentId,
          cwd,
          title: entry.title,
          kind: entry.kind,
          command: entry.kind === "oma" ? target.omaPane : target.shell,
        });
      } catch {
        // agent/project gone — drop silently; sync() below prunes it
      }
    }
    // Prune skipped entries (agent/project gone) so they stop retrying
    // every boot even when nothing else mutates membership afterwards.
    codingRegistry.sync();
  })();

  // Removal is symmetric with creation, with two server-side guards:
  // a live terminal would have its cwd yanked away, and uncommitted
  // changes are never discarded without the explicit force flag.
  const removeCodingTaskWorktree = async (
    projectId: string,
    agentId: string,
    slug: string,
    force: boolean,
  ) => {
    const target = await resolveCodingTarget(projectId, agentId);
    const project = projectSvc.getById(projectId);
    if (!project?.repoUrl) throw new NotFoundError("project", projectId);
    const agent = (await agentSvc.list(true)).find((a) => a.id === agentId);
    if (!agent) throw new NotFoundError("agent", agentId);
    const path = validateWorktreePath(
      agent.workspacePath,
      projectId,
      `${target.cwd}.${slug}`,
    ) as string;
    if (codingRegistry.list().some((t) => t.cwd === path && t.status === "running")) {
      throw new ConflictError("close this worktree's terminals first (running processes)");
    }
    const wtProject = {
      projectId: project.projectId,
      repoUrl: project.repoUrl,
      defaultBranch: project.defaultBranch,
    };
    const mirror = await ensureMirror(config.dataDir, wtProject);
    await removeTaskWorktree(mirror, agent.workspacePath, wtProject, agentId, slug, { force });
    // Frozen (exited) terminals of that path would point at a directory
    // that no longer exists — drop them so the rail tells the truth.
    for (const t of codingRegistry.list()) {
      if (t.cwd === path) codingRegistry.close(t.terminalId);
    }
    return { path };
  };

  // ─── Agentic Workflow ───────────────────────────────────
  const workflowPort = sqliteWorkflowExecutionAdapter(db);
  const workflowNodeRunners = createNodeRunners({
    dataDir: config.dataDir,
    // H2: script nodes are opt-in; the sandbox denies reads over the
    // data dir and the deployment's .env, and cuts network (bwrap/
    // sandbox-exec when available).
    scriptsEnabled: config.workflowScriptsEnabled,
    denyReadDirs: config.workflowScriptDenyReadDirs,
    // A script log is a durable fact: it lands in the trace the execution page reads.
    onLog: (executionId, data) =>
      workflowPort
        .appendExecutionEvent({ executionId, event: "script_log", data, ts: Date.now() })
        .catch(() => {}),
  });
  const workflowExecutionService = createWorkflowExecutionService({
    port: workflowPort,
    nodeRunners: workflowNodeRunners,
    idGen: ulid,
    agentRunService,
    agentRunExecution,
    convPort,
    conversationService: conv.convSvc,
    artifactService,
    resolveDefaultModel: async (agentId) => agentModelRef(await agentSvc.getById(agentId)),
    agentProjects: async (agentId) =>
      (await agentSvc.getById(agentId))?.config.runtime_config.projects ?? [],
  });
  // Builtin showcase: seed the sample workflows on first boot (user has none
  // yet) from <resources>/workflow-showcase. A packaged stack may ship without
  // them, so a missing directory is skipped, not fatal.
  {
    const wfDir = join(config.dataDir, "workflows");
    mkdirSync(wfDir, { recursive: true });
    const existing = readdirSync(wfDir).filter((f) => f.endsWith(".workflow.json"));
    if (existing.length === 0 && existsSync(config.workflowShowcaseDir)) {
      for (const f of readdirSync(config.workflowShowcaseDir)) {
        if (f.endsWith(".workflow.json")) {
          copyFileSync(join(config.workflowShowcaseDir, f), join(wfDir, f));
          console.log(`[bootstrap] seeded showcase workflow: ${f}`);
        }
      }
    }
  }

  const workflowTriggerScheduler = createWorkflowTriggerScheduler({
    workflowDir: join(config.dataDir, "workflows"),
    schedule: (expr: string, fn: () => void) => {
      const h = Bun.cron(expr, fn);
      return { stop: () => h.stop() };
    },
    startExecution: (input: {
      workflowId: string;
      definition: WorkflowDefinition;
      input: Record<string, unknown>;
    }) => workflowExecutionService.startExecution(input),
    listExecutions: (workflowId: string) => workflowExecutionService.listExecutions(workflowId),
  });

  // Reminder tick (raft step 2): DB rows are the truth, so a 30s scan is
  // restart-safe (missed reminders fire on the first tick after boot).
  const reminderInterval = setInterval(() => {
    void reminderSvc.fireDue().catch((err: unknown) => {
      console.error("[reminder] tick failed:", err instanceof Error ? err.message : err);
    });
  }, 30_000);

  // Human-node timeouts (DSL `timeoutMs`): a parked execution has no live loop,
  // so this scan is its only clock. DB rows are the truth → a task that expired
  // while the process was down settles on the first tick after boot.
  const humanTimeoutInterval = setInterval(() => {
    void workflowExecutionService.expireHumanTimeouts().catch((err: unknown) => {
      console.error(
        "[workflow] human timeout tick failed:",
        err instanceof Error ? err.message : err,
      );
    });
  }, 30_000);

  // Artifact retention (opt-in, ARTIFACT_RETENTION_DAYS): 0/unset keeps every
  // artifact forever — they are the user's own files and age alone is never a
  // reason to delete. A daily tick, plus one sweep at boot so configuring a
  // window takes effect on the next restart rather than a day later.
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

  const workflowApp = workflowRoutes({
    workflowExecutionService,
    loadWorkflow: async (ref) => {
      // Containment: http.ts validates the "<stem>.workflow.json" shape, but
      // this is the boundary — resolve and verify before touching disk.
      const workflowsDir = join(config.dataDir, "workflows");
      const file = join(workflowsDir, ref.path);
      if (!resolve(file).startsWith(resolve(workflowsDir))) {
        throw new Error(`workflow path escapes workflows dir: ${ref.path}`);
      }
      return await Bun.file(file).text();
    },
    workflowDir: join(config.dataDir, "workflows"),
    // Trigger tokens live in the sealed settings KV, NOT in the workflows dir
    // (definitions are agent-writable; a token the agent can read is a token
    // anything on the box can read — same boundary as the path policy).
    scriptsEnabled: config.workflowScriptsEnabled,
    getTriggerToken: async (workflowId) =>
      settingsSvc.get<string>(`workflow.trigger.${workflowId}`),
    setTriggerToken: async (workflowId, token) => {
      settingsSvc.set(`workflow.trigger.${workflowId}`, token);
    },
    resyncTriggers: () => workflowTriggerScheduler.sync(),
  });

  const passwordSvc = createPasswordService(settingsSvc, { dataDir: config.dataDir });

  // The launcher's password (env/secret) is a BOOTSTRAP credential: adopt it
  // once, as a hash, then the DB is the only source. Without this, a regenerated
  // .env or gateway secret silently changes the login password, and a password
  // set in the console stops matching as soon as the stack is launched another
  // way.
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
    // Neither a stored password nor a bootstrap one: login is locked until
    // someone sets one. Loud, because the usual cause is wiring (the bootstrap
    // value not reaching THIS process) rather than an intentional choice.
    console.error(
      "[auth] no login password stored and no MOCK_PASSWORD bootstrap in this process's env;",
      "set MOCK_PASSWORD or run scripts/reset-login-password.sh once the console is up",
    );
  }

  // A wildcard bind is not a host a browser can reach: hand the client a loopback address.
  const browserWsBase = `ws://${
    config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host
  }:${config.port}`;

  // The AHP face (ADR 0040): the protocol machinery lives in features/ahp, and this is where the
  // state source and the command port attach. The source is a read-only projection - sessions and
  // chats come from the canonical model - and the command port refuses until the control plane is
  // wired to it.
  /** The projection: the face serves it, and the chat writer reads it back to re-state a committed
   *  turn exactly as a fresh subscriber would read it. */
  const ahpSource = createAhpStateSource({
    listAgents: async () =>
      (await agentSvc.list(false)).map((agent) => ({
        id: agent.id,
        name: agent.config.name,
        harness: agent.config.runtime_config.harness,
        // The harness's own model, in that harness's vocabulary; "" = its default.
        model: agent.config.runtime_config.model,
      })),
    harnessModels: async (harness) =>
      (await harnessCatalog.list()).find((h) => h.key === harness)?.models ?? [],
    getConversation: (conversationId) => conv.convPort.getConversation(conversationId),
    getLedgerEntries: (conversationId) => conv.convPort.getLedgerEntries(conversationId),
    listPendingInputs: async (conversationId) =>
      // Every status: a turn's message is the input that started it, and that input has left the
      // queue by the time the turn is history.
      (await agentRunPort.listInputsForConversation(conversationId)).map((input) => ({
        runId: input.runId,
        message: JSON.stringify(input.message),
      })),
    // The canonical model takes plain row objects only: action payloads and answers are
    // serialized here, so product types never leak into it.
    listPendingActions: async (runId) =>
      (await agentRunPort.listPendingActions(runId)).map((action) => ({
        actionId: action.actionId,
        kind: action.kind,
        status: action.status,
        payload: JSON.stringify(action.payload),
        response: action.response === null ? null : JSON.stringify(action.response),
      })),
    getRun: (runId) => agentRunPort.getRun(runId),
    listActiveRuns: (conversationId) =>
      agentRunPort.listRecentRunsForConversations([conversationId], 10 * 60_000).catch(() => []),
    // Todos are stored per branch; the chat state keys them by run.
    workspaceRootOf: async (conversationId) => {
      const row = conv.convPort.getConversation(conversationId);
      const workspace = await peekWorkspaceFor({
        conversationId,
        agentId: row?.agentId ?? null,
      }).catch(() => null);
      return workspace?.root ?? null;
    },
    latestRunTodo: async (runId) => {
      const run = await agentRunPort.getRun(runId);
      return run ? agentRunPort.getLatestRunTodo(run.branchId) : null;
    },
    // The activity lines a run wrote while it worked (its own describeStart output). They
    // live in the run telemetry, which is where "how the run behaved" belongs; the ledger
    // stays the canonical outcome. A rebuilt card therefore labels a call the way the live
    // stream did, and a rail that records no activity simply keeps the tool name.
    toolActivities: async (runId) => {
      const activities = new Map<string, string>();
      for (const event of services.opsStore.listRunEvents(runId, 2000)) {
        if (event.type !== "native_tool_started") continue;
        const callId = event.data.callId;
        const activity = event.data.activity;
        if (typeof callId === "string" && typeof activity === "string") {
          activities.set(callId, activity);
        }
      }
      return activities;
    },
  });

  const ahpHost = createAhpHost({
    wsBase: browserWsBase,
    source: ahpSource,
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
      // Skill/knowledge pack symlinks resolve into the data dir; the
      // read-only workspace file view is allowed to follow them there.
      [config.dataDir],
      larkSurfaceFactsOf,
      modelKnownForBackend,
    ),
    conversations: conversationRoutes(
      conv.convSvc,
      ulid,
      (id: string) => projectSvc.exists(id),
      conversationMembers,
      async (id: string) => {
        try {
          return (await agentSvc.getById(id)).config.role;
        } catch {
          return undefined;
        }
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
        await agentRunPort.correctActionResponse(actionId, response);
        const run = await agentRunPort.getRun(action.runId).catch(() => null);
        if (run === null) return { ok: true as const };
        await conv.convSvc.postMessage({
          conversationId: run.conversationId,
          senderMemberId: "user",
          addressedTo: [run.agentId],
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
    }),
    coding: codingRoutes({
      registry: codingRegistry,
      resolveTarget: resolveCodingTarget,
      listTaskWorktrees: listCodingTaskWorktrees,
      createTaskWorktree: createCodingTaskWorktree,
      removeTaskWorktree: removeCodingTaskWorktree,
      wsBase: browserWsBase,
    }),
    ahp: ahpHost.routes,
    requirements: requirementRoutes(requirementSvc),
    wiki: wikiRoutes(wikiSvc),
    projects: projectRoutes(projectSvc, worktreeOps),
    skillPacks: skillPackRoutes(skillPackSvc, config.dataDir),
    mcp: mcpRoutes(mcpSvc),
    workflowExecutions: workflowApp,
    artifacts: artifactRoutes(artifactService),
    proactive: proactiveRoutes(proactiveSvc),
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
    }),

    auth: authRoutes(passwordSvc),

    providers: providerRoutes(providerSvc, { onChange: refreshOmaProviderEnv }),

    harnesses: harnessRoutes(harnessCatalog),
    models: modelRoutes(
      {
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
      },
      // Provider-catalogue health: the aggregate /api/models above fails
      // wholesale when the CLI listing fails — that blind spot is exactly
      // what this endpoint exists to expose. Harness probes have their own
      // health row inside /api/harnesses.
      async () => {
        try {
          const list = (await codingAgentCatalog.list()).models;
          return [
            {
              backendKind: "oma",
              catalogOk: true,
              models: list.length,
              available: list.filter((m) => m.available !== false).length,
              error: null,
            },
          ];
        } catch (err) {
          return [
            {
              backendKind: "oma",
              catalogOk: false,
              models: 0,
              available: 0,
              error: err instanceof Error ? err.message : String(err),
            },
          ];
        }
      },
    ),
  };

  // ─── Lifecycle ──────────────────────────────────────────────

  // Self-smoke cron (docs/insights.md I4): when SMOKE_CRON is set, spawn
  // the workflow smoke as a separate process on schedule. A workflow
  // script-node cannot host this - the smoke boots a second in-process
  // backend, which would be circular inside a product execution.
  let smokeCron: { stop(): unknown } | undefined;

  async function start(): Promise<void> {
    await workflowTriggerScheduler.sync();
    // Reminder catch-up: anything due while the process was down fires now.
    void reminderSvc.fireDue().catch((err: unknown) => {
      console.error("[reminder] boot catch-up failed:", err instanceof Error ? err.message : err);
    });
    // Agent-run recovery first: redeliver delivering inputs, promote crash
    // gaps, retry commit_failed commits, terminalize restart orphans — old
    // state is settled BEFORE workflow recovery re-drives executions that
    // will dispatch fresh Runs onto those same branches.
    // ORDER (#43): agent-run recovery settles every orphan/parked run to a
    // stable status FIRST; workflow re-drive consumes only stable states, so
    // it must never observe a run mid-recovery and misjudge it as timed out.
    await agentRunExecution.recover();
    await workflowExecutionService.recover();
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
      smokeCron = Bun.cron(smokeCronExpr, () => {
        void (async () => {
          const smokeEntry = join(import.meta.dir, "../../../../scripts/smoke-workflow.ts");
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

  async function dispose(): Promise<void> {
    // Order matters: stop producing Runs first, then kill every Coding
    // Agent child and drain in-flight dispatches (the DB must not close
    // mid-finalize), THEN close surfaces that children may still call
    // (Product Tools MCP) and finally Lark/setup.
    smokeCron?.stop();
    clearInterval(reminderInterval);
    clearInterval(humanTimeoutInterval);
    clearInterval(artifactRetentionInterval);
    await agentRunExecution.dispose(); // abort/SIGTERM/SIGKILL children + drain
    codingRegistry.closeAll(); // PTYs die with the children, not with the OS
    await workflowTriggerScheduler.dispose();
    await larkBotRegistry.dispose();
    setupManager?.dispose();
    await productToolsMcp?.close();
    await workflowMcp?.close();
  }

  // Seed the default agent AFTER the whole wiring (the catalog const and
  // the reconcile binding): an early call reads a TDZ const and skips the
  // workspace reconcile (no skills links, no .mcp.json).
  {
    const seed = await defaultSeedModel();
    // ADR 0074: the personal agent plus a team whose capability cards differ,
    // so dispatch-by-capability has something to choose between. The worker
    // role is the difference between a team member and a second front desk.
    //
    // A marker records what this install has seeded: without it, deleting a
    // seed-created member would resurrect it on the next boot (the guide-agent
    // problem), and with it a deliberate deletion sticks.
    const markerPath = join(config.dataDir, ".agent-seed.json");
    const seeded = new Set<string>();
    try {
      const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as { seeded?: string[] };
      for (const id of parsed.seeded ?? []) seeded.add(id);
    } catch {
      /* first boot */
    }

    await ensureAgent("default", "Personal Agent", {
      harness: seed.harness,
      ...(seed.model ? { model: seed.model } : {}),
      description:
        "Personal agent — manages your attention: understands, dispatches, keeps the wiki",
    });
    await seedSoul("default", SEED_SOULS.default ?? "");

    const team = await agentSvc.list();
    const workerNames = new Set(
      team.filter((agent) => agent.config.role === "worker").map((agent) => agent.config.name),
    );
    // ADR 0056: choosing a worker IS a capability recall over these cards. A
    // card that names an identity ("software engineer") matches nothing; one
    // that names the WORK does. Live 2026-11-21 the front desk could not map
    // "investigate this repo" onto "执行派下来的具体改动" and did the
    // investigation itself.
    const members = [
      {
        id: "coder",
        name: "Coder",
        description:
          "读代码、查实现、跑测试、改代码的工程师。有 shell 与文件工具，工作在自己的仓库副本里：" +
          "可以回答「这个项目某功能怎么实现的」「为什么这里会报错」，也能直接改代码并验证。",
      },
      {
        id: "researcher",
        name: "Researcher",
        description:
          "调研与比较：收集外部资料、核对事实、比较多个方案并给出取舍与依据。产出是判断依据，" +
          "不做代码实现。适合「调研/比较/写一份分析」这类需要查证的工作。",
      },
    ];
    for (const member of members) {
      // Match by NAME, not id: an upgraded install may already have this
      // member under a different id, and a second Coder is worse than none.
      // The marker keeps a deleted member deleted.
      if (workerNames.has(member.name)) continue;
      if (seeded.has(member.id)) continue;
      await ensureAgent(member.id, member.name, {
        harness: seed.harness,
        ...(seed.model ? { model: seed.model } : {}),
        description: member.description,
        role: "worker",
      });
      await seedSoul(member.id, SEED_SOULS[member.id] ?? "");
      seeded.add(member.id);
    }
    seeded.add("default");
    writeFileSync(markerPath, JSON.stringify({ seeded: [...seeded] }, null, 2), "utf8");

    // ADR 0074: knowledge decays unless someone sweeps it. A nightly workflow
    // has the personal agent run wiki_lint and repair what it finds — no human
    // gate, because lint is maintenance, not a decision; the attention inbox
    // stays for things that need the person.
    const workflowPath = join(config.dataDir, "workflows", "wiki-lint.workflow.json");
    if (!existsSync(workflowPath)) {
      mkdirSync(join(config.dataDir, "workflows"), { recursive: true });
      writeFileSync(
        workflowPath,
        JSON.stringify(
          {
            version: 1,
            id: "wiki-lint",
            triggers: [{ type: "cron", cron: "0 4 * * *" }],
            meta: {
              name: "Nightly wiki lint",
              description:
                "每天凌晨检查知识库：补来源、补回链、修正悬空的 supersedes；只做维护，不打扰人",
              tags: ["wiki", "maintenance"],
              status: "active",
              owner: "system",
              updatedBy: "seed",
            },
            nodes: [
              { id: "start", type: "start" },
              {
                id: "lint",
                type: "agent",
                ...(seed.model ? { model: seed.model } : {}),
                agentId: "default",
                prompt: [
                  "你是这个知识库的维护者。目标不是把 findings 清零，而是让库里的知识保持可信、可查、不互相打架。",
                  "",
                  "第一步：wiki_query 读 index 概览，再运行 wiki_lint 取回全部 findings。",
                  "",
                  "第二步：按下面的清单做检查（Karpathy 的 wiki-lint 纪律），findings 只是入口：",
                  "1) 无来源（unsourced）：能在这轮材料或其它页面里找到出处的，用 wiki_patch 补 sources；",
                  "   找不到的，把 status 降为 draft，并在正文末尾加一行「来源待补」。",
                  "2) 孤儿（orphan）：找语义相关的页面，在它的正文末尾加一条链接指向本页；",
                  "   没有相关页面的，把本页的标题挂到最相关父页的列表里。",
                  "3) 悬空 supersedes：删掉那条指向不存在页面的条目。",
                  "4) 过时（stale）：某页 status=confirmed 但正文与新页面冲突时，不要改结论——",
                  "   在两页里各加一行「与 [[另一页]] 的说法不一致，待裁决」，并把较旧的一页降为 draft。",
                  "5) 缺失概念页：同一个概念被三个以上页面链接却还没有自己的页面时，建一个 stub（只放定义与来源）。",
                  "",
                  "第三步：动手规则",
                  "- 每处修改前先 wiki_read 拿当前 revision，再带 expected_revision 调 wiki_patch；被拒绝就重读、重合并、重试。",
                  "- 只做最小修复：不重写整页，不改变已经确认的结论，不删除内容。",
                  "- 不碰 personal/ 下不属于你的页面；不修改 raw/；不创建无来源的页面。",
                  "- 冲突永远只标记、不裁决——裁决是人的事。",
                  "",
                  "最后输出一句话：检查了几页、改了几处、哪几处留给人类裁决。",
                ].join("\n"),
                output: [{ key: "summary", type: "string" }],
                outputSchema: {
                  type: "object",
                  properties: { summary: { type: "string" } },
                  required: ["summary"],
                },
                retry: { maxAttempts: 1, intervalMs: 2000 },
              },
              { id: "done", type: "end", status: "success" },
            ],
            edges: [
              { from: "start", to: "lint" },
              { from: "lint", to: "done" },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );
    }
  }

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
    start,
    dispose,
  };
}
