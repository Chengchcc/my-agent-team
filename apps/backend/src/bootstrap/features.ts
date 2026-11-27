import { join } from "node:path";
import type { Message } from "@chengchenccc/message";
import type { FeatureSet } from "../app.js";
import { createAgentSvc } from "../features/agent/agent-compose.js";
import { createAgentIdentityStore } from "../features/agent/agent-identity.js";
import { AgentBusyError } from "../features/agent/index.js";
import {
  createAgentContextService,
  sqliteAgentContextAdapter,
} from "../features/agent-context/index.js";
import type { LedgerMessageResolver } from "../features/agent-context/ports.js";
import {
  type AgentRunExecutionService,
  type AgentRunService,
  sqliteAgentRunAdapter,
} from "../features/agent-run/index.js";
import type { RecallHit } from "../features/agent-run/recall.js";
import {
  createArtifactFsAdapter,
  createArtifactService,
  createSqliteArtifactIndexAdapter,
} from "../features/artifact/index.js";
import { createConversationFeature } from "../features/conversation/conversation-compose.js";
import { sqliteConversationAdapter } from "../features/conversation/index.js";
import { createConfiguredSummarizer } from "../features/conversation/summarize.js";
import { createMcpRuntimeStatusStore } from "../features/mcp/index.js";
import type { ProductToolsService } from "../features/product-tools/index.js";
import { createWorkspaceLockRegistry } from "../features/project/workspace-lock.js";
import {
  createProposalService,
  type ProposalService,
  sqliteProposalAdapter,
} from "../features/proposal/index.js";
import {
  createRequirementService,
  sqliteRequirementAdapter,
} from "../features/requirement/index.js";
import { createFsWikiStore, createWikiService } from "../features/wiki/index.js";
import type { WorkflowExecutionService } from "../features/workflow/index.js";
import { createEntityLabelResolver } from "../infra/entity-labels.js";
import { ulid } from "../infra/ids.js";
import type { BackendServices } from "./services.js";
import {
  buildAgentSystemPrompt,
  createRoleOfAgent,
  wireAgentRunExecution,
  wireAgentRunService,
  wireRunCoordination,
} from "./wiring-agent-run.js";
import { wireAhp } from "./wiring-ahp.js";
import { wireCatalogs } from "./wiring-catalog.js";
import { wireCodingAndWorktrees } from "./wiring-coding.js";
import { wireLifecycle } from "./wiring-lifecycle.js";
import { wireOpsAndMcp } from "./wiring-ops-mcp.js";
import { wireProductTools } from "./wiring-product-tools.js";
import { wireFeatureSet } from "./wiring-routes.js";
import { seedDefaultTeamAndWorkflows } from "./wiring-seed.js";
import { wireWorkflows } from "./wiring-workflows.js";
import { wireWorkspaceAndRecall } from "./wiring-workspace.js";

export { buildAgentSystemPrompt };

export interface InstalledFeatures {
  featureSet: FeatureSet;
  proposalSvc: ProposalService;
  agentRunService: AgentRunService;
  agentRunExecution: AgentRunExecutionService;
  productTools: ProductToolsService;
  workflowExecutionService: WorkflowExecutionService;

  prepare(): Promise<void>;
  start(): Promise<void>;
  dispose(): Promise<void>;
}

/** Composition root: instantiates core domain services and wires the 9
 *  domain wiring modules in strict dependency order. */
export async function installFeatures(services: BackendServices): Promise<InstalledFeatures> {
  const { config, db, settingsSvc, mcpClientManager, larkBotRegistry } = services;

  // ─── 1. Providers, Harnesses, Model & Skill-Pack Catalogs ───
  const {
    providerSvc,
    codingAgentCatalog,
    refreshOmaProviderEnv,
    omaAcpArgv,
    harnessCatalog,
    servedModelKnowledge,
    skillPackPort,
    skillPackSvc,
  } = await wireCatalogs({ config, db, ulid, settingsSvc, probeEnv: process.env });
  const mcpRuntimeStatus = createMcpRuntimeStatusStore();

  // ─── 2. Proposals & Agent Service ───────────────────────────
  const proposalSvc = createProposalService({ port: sqliteProposalAdapter(db), idGen: ulid });

  const busyGuard: { check: ((agentId: string) => void) | undefined } = { check: undefined };
  const workspaceLocks = createWorkspaceLockRegistry();
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
    ...(services.larkProfileInit ? { profileInit: services.larkProfileInit } : {}),
  });

  // ─── 3. Ledger, Context, Run Port, Requirements, Wiki & Artifacts ──
  const convPort = sqliteConversationAdapter(db);
  const ledgerResolver: LedgerMessageResolver = {
    async resolveMessage(conversationId, ledgerSeq) {
      const entry = convPort.getLedgerEntry(conversationId, ledgerSeq);
      if (entry?.kind !== "message") return null;
      return (entry.content as unknown as Message) ?? null;
    },
  };
  const contextPort = sqliteAgentContextAdapter(db, { ulid });
  const contextSvc = createAgentContextService({
    port: contextPort,
    idGen: { ulid },
    ledgerResolver,
  });
  const roleOfAgent = createRoleOfAgent(db);
  const agentRunPort = sqliteAgentRunAdapter(db, {
    contextPort,
    ledgerResolver,
    idGen: { ulid },
    roleOfAgent,
  });
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

  const requirementSvc = createRequirementService({
    port: sqliteRequirementAdapter(db),
    idGen: ulid,
  });
  const wikiSvc = createWikiService({ store: createFsWikiStore(join(config.dataDir, "wiki")) });
  const identityStore = createAgentIdentityStore({
    dataDir: config.dataDir,
    getAgent: (id: string) => agentSvc.getById(id),
  });
  const entityLabels = createEntityLabelResolver(db, {
    workflowDir: join(config.dataDir, "workflows"),
  });
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

  // ─── 4. Ops, Projects, MCP Bridge, Workspaces & AHP ─────────
  const enabledMcpServers = new Set(
    (config.enabledMcpServers ?? "product-tools,agent,workflow")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
  const mcpUrls: { workflow: string | null; agentConfig: string | null } = {
    workflow: null,
    agentConfig: null,
  };

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
    convPort,
    skillPackPort,
    larkBotRegistry,
    opsStore: services.opsStore,
    mcpClientManager,
    mcpRuntimeStatus,
    entityLabels,
    enabledMcpServers,
    getWorkflowMcpUrl: () => mcpUrls.workflow,
    getAgentConfigMcpUrl: () => mcpUrls.agentConfig,
  });
  reconcileAgent.fn = reconcileAgentImpl;

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
    convPort,
    agentRunPort,
    requirementSvc,
    settingsSvc,
    codingAgentCatalog,
    getProjectSvc: () => projectSvc,
  });

  const { browserWsBase, ahpHost, chatWriter } = wireAhp({
    config,
    agentSvc,
    harnessCatalog,
    convPort,
    agentRunPort,
    artifactService,
    opsStore: services.opsStore,
    peekWorkspaceFor,
  });

  // ─── 5. Agent Runs, Conversations, Product Tools & Execution ─
  const agentRunService = wireAgentRunService({
    config,
    agentSvc,
    agentRunPort,
    contextSvc,
    ledgerResolver,
    identityStore,
    skillPackPort,
    convPort,
    projectSvc,
    opsStore: services.opsStore,
    ulid,
  });

  // Only genuine mutual cycles remain late-bound: conv ↔ execution ↔ productTools.
  let agentRunExecutionRef: AgentRunExecutionService | null = null;
  let productToolsRef: ProductToolsService | null = null;

  const summarizeFromConfig = createConfiguredSummarizer(config.summaryModel, (id) =>
    providerSvc.credentialFor(id),
  );
  const conv = createConversationFeature({
    convPort,
    agentSvc,
    agentRunService,
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
    dispatchRun: async (runId) => {
      await agentRunExecutionRef?.dispatch(runId);
    },
    injectSteer: async (branchId, input, opts) => {
      await agentRunExecutionRef?.injectSteer(branchId, input, opts);
    },
    isLive: (runId) => agentRunExecutionRef?.isLive(runId) ?? false,
    isInflight: (runId) => agentRunExecutionRef?.isInflight(runId) ?? false,
    abortStaleRun: async (runId) => {
      await agentRunExecutionRef?.abortStaleRun(runId);
    },
    onContinuityRecorded: (input) => {
      void chatWriter
        .announceContinuity(input)
        .catch((err) =>
          console.error(
            `[bootstrap] continuity announcement failed for ${input.conversationId}:`,
            err,
          ),
        );
    },
    onMessagesUndone: ({ conversationId }) => {
      void chatWriter.announceMessagesUndone(conversationId).catch((err) => {
        console.error(`[ahp] undo announce failed for ${conversationId}:`, err);
      });
    },
    contextService: contextSvc,
    answerPendingTextAsk: async (conversationId, text) => {
      if (!productToolsRef) return false;
      const ask = await productToolsRef.pendingTextAskForConversation(conversationId);
      if (!ask) {
        void productToolsRef.observeOrphanTextAnswer(conversationId);
        return false;
      }
      return await productToolsRef.resolveAskDurable(ask.runId, ask.callId, {
        answers: [{ id: ask.questionId, selectedValues: [], freeText: text }],
      });
    },
  });

  const { notifyDispatcher, onRequestCreated } = wireRunCoordination({
    agentSvc,
    agentRunPort,
    contextPort,
    convPort,
    convSvc: conv.convSvc,
    roleOfAgent,
    injectSteer: async (branchId, input, opts) => {
      await agentRunExecutionRef?.injectSteer(branchId, input, opts);
    },
  });

  const recallByRun = new Map<string, readonly RecallHit[]>();
  const {
    reminderSvc,
    productTools,
    productToolsTokenRegistry,
    workflowMcpUrl,
    agentConfigMcpUrl,
    closeMcpServers,
  } = await wireProductTools({
    config,
    db,
    ulid,
    settingsSvc,
    opsStore: services.opsStore,
    agentSvc,
    agentRunPort,
    contextPort,
    convPort,
    convSvc: conv.convSvc,
    artifactService,
    requirementSvc,
    wikiSvc,
    proposalSvc,
    projectSvc,
    workspaceSvc,
    checkoutOf,
    chatWriter,
    enabledMcpServers,
    recallByRun,
    notifyDispatcher,
    onRequestCreated,
    injectSteer: async (branchId, input, opts) => {
      await agentRunExecutionRef?.injectSteer(branchId, input, opts);
    },
    getAgentRunExecution: () => agentRunExecutionRef,
  });
  productToolsRef = productTools;
  mcpUrls.workflow = workflowMcpUrl;
  mcpUrls.agentConfig = agentConfigMcpUrl;

  const { agentRunExecution, sandboxProxy } = await wireAgentRunExecution({
    config,
    db,
    ulid,
    settingsSvc,
    opsStore: services.opsStore,
    agentSvc,
    agentRunPort,
    agentRunService,
    contextPort,
    convPort,
    ledgerResolver,
    artifactService,
    requirementSvc,
    workspaceSvc,
    workspaceForRun,
    workspaceLocks,
    budgetGate,
    memoryRecall,
    chatWriter,
    mcpRuntimeStatus,
    prepareMcpBridge,
    productToolsManifest,
    enabledMcpServers,
    omaAcpArgv,
    productTools,
    productToolsTokenRegistry,
    recallByRun,
    notifyDispatcher,
    onRequestCreated,
  });
  agentRunExecutionRef = agentRunExecution;

  // ─── 6. Coding Terminals, Workflows, Auth & Routes ──────────
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

  const { passwordSvc, prepare, start, dispose } = await wireLifecycle({
    config,
    db,
    settingsSvc,
    agentSvc,
    agentRunExecution,
    workflowExecutionService,
    workflowTriggerScheduler,
    reminderSvc,
    artifactService,
    codingRegistry,
    restoreCodingTerminals,
    larkBotRegistry,
    closeMcpServers,
    closeSandboxProxy: async () => {
      await sandboxProxy?.close();
    },
    disposeSetupManager,
  });

  const featureSet = wireFeatureSet({
    config,
    db,
    ulid,
    agentSvc,
    skillPackSvc,
    reconcileAgent: (id) => reconcileAgent.fn(id),
    identityStore,
    larkBotRegistry,
    getSetupManager,
    larkSurfaceFactsOf,
    projectSvc,
    worktreeOps,
    convSvc: conv.convSvc,
    entityLabels,
    reminderSvc,
    opsSvc,
    opsStore: services.opsStore,
    agentRunPort,
    agentRunService,
    agentRunExecution,
    modelCostsSnapshot,
    budgetGate,
    codingRegistry,
    resolveCodingTarget,
    browserWsBase,
    ahpHost,
    requirementSvc,
    wikiSvc,
    mcpSvc,
    workflowApp,
    artifactService,
    productTools,
    settingsSvc,
    proposalSvc,
    passwordSvc,
    providerSvc,
    refreshOmaProviderEnv,
    harnessCatalog,
    codingAgentCatalog,
    servedModelKnowledge,
  });

  await seedDefaultTeamAndWorkflows({ config, agentSvc, codingAgentCatalog });

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
