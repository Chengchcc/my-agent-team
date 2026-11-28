import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FeatureSet } from "../app.js";
import type { BackendConfig } from "../config.js";
import type { AgentIdentityStore } from "../features/agent/agent-identity.js";
import { type AgentService, agentRoutes } from "../features/agent/index.js";
import type { BudgetGate } from "../features/agent-run/budget-gate.js";
import {
  type AgentRunExecutionService,
  type AgentRunPort,
  type AgentRunService,
  agentRunRoutes,
} from "../features/agent-run/index.js";
import type { AhpHost } from "../features/ahp/index.js";
import { type ArtifactService, artifactRoutes } from "../features/artifact/index.js";
import { authRoutes, type PasswordService } from "../features/auth/index.js";
import {
  type CodingTarget,
  type CodingWorkspaceReader,
  codingRoutes,
  type TerminalRegistry,
} from "../features/coding/index.js";
import { conversationRoutes } from "../features/conversation/index.js";
import type { ConversationService } from "../features/conversation/service.js";
import type { LarkBotRegistry, LarkSetupManager } from "../features/lark-bot/index.js";
import { type McpService, mcpRoutes } from "../features/mcp/index.js";
import {
  applyServedAvailability,
  bareModelId,
  type createOmaModelCatalog,
  type HarnessCatalog,
  harnessRoutes,
  modelRoutes,
  providerOfModelId,
  type ServedModelKnowledge,
} from "../features/models/index.js";
import type { ProductToolsService } from "../features/product-tools/index.js";
import { type ProjectService, projectRoutes } from "../features/project/index.js";
import type { WorktreeOps } from "../features/project/worktree-ops.js";
import {
  ProposalNotApplicable,
  type ProposalService,
  proposalRoutes,
} from "../features/proposal/index.js";
import { type ProviderService, providerRoutes } from "../features/provider/index.js";
import { type ReminderService, reminderRoutes } from "../features/reminder/index.js";
import { type RequirementService, requirementRoutes } from "../features/requirement/index.js";
import {
  opsRoutes,
  type RuntimeOpsService,
  type RuntimeOpsStore,
} from "../features/runtime-ops/index.js";
import { type SettingsService, settingsRoutes } from "../features/settings/index.js";
import {
  type SkillPackRow,
  type SkillPackService,
  skillPackRoutes,
} from "../features/skill-pack/index.js";
import { type WikiService, wikiRoutes } from "../features/wiki/index.js";
import type { EntityLabelResolver } from "../infra/entity-labels.js";
import type { wireOpsAndMcp } from "./wiring-ops-mcp.js";
import type { wireWorkspaceAndRecall } from "./wiring-workspace.js";

export interface FeatureRoutesWiringDeps {
  config: BackendConfig;
  db: Database;
  ulid: () => string;
  agentSvc: AgentService;
  skillPackSvc: SkillPackService;
  reconcileAgent: (agentId: string) => Promise<void>;
  identityStore: AgentIdentityStore;
  larkBotRegistry: LarkBotRegistry;
  getSetupManager: () => LarkSetupManager;
  larkSurfaceFactsOf: ReturnType<typeof wireOpsAndMcp>["larkSurfaceFactsOf"];
  projectSvc: ProjectService;
  worktreeOps: WorktreeOps;
  convSvc: ConversationService;
  entityLabels: EntityLabelResolver;
  reminderSvc: ReminderService;
  opsSvc: RuntimeOpsService;
  opsStore: RuntimeOpsStore;
  agentRunPort: AgentRunPort;
  agentRunService: AgentRunService;
  agentRunExecution: AgentRunExecutionService;
  modelCostsSnapshot: ReturnType<typeof wireWorkspaceAndRecall>["modelCostsSnapshot"];
  budgetGate: BudgetGate;
  codingRegistry: TerminalRegistry;
  codingWorkspaceReader: CodingWorkspaceReader;
  resolveCodingTarget: (
    projectId: string | null | undefined,
    agentId: string,
    workspaceId?: string,
  ) => Promise<CodingTarget>;
  browserWsBase: string;
  ahpHost: AhpHost;
  requirementSvc: RequirementService;
  wikiSvc: WikiService;
  mcpSvc: McpService;
  workflowApp: FeatureSet["workflowExecutions"];
  saveWorkflowDefinition: (workflowId: string, definition: unknown) => Promise<void>;
  artifactService: ArtifactService;
  productTools: ProductToolsService;
  settingsSvc: SettingsService;
  proposalSvc: ProposalService;
  passwordSvc: PasswordService;
  providerSvc: ProviderService;
  refreshOmaProviderEnv: () => void;
  harnessCatalog: HarnessCatalog;
  codingAgentCatalog: ReturnType<typeof createOmaModelCatalog>;
  servedModelKnowledge: ServedModelKnowledge;
}

/** Assemble the HTTP/WS FeatureSet mounted by Elysia in `createApp()`. */
export function wireFeatureSet(deps: FeatureRoutesWiringDeps): FeatureSet {
  const {
    config,
    db,
    ulid,
    agentSvc,
    skillPackSvc,
    reconcileAgent,
    identityStore,
    larkBotRegistry,
    getSetupManager,
    larkSurfaceFactsOf,
    projectSvc,
    worktreeOps,
    convSvc,
    entityLabels,
    reminderSvc,
    opsSvc,
    opsStore,
    agentRunPort,
    agentRunService,
    agentRunExecution,
    modelCostsSnapshot,
    budgetGate,
    codingRegistry,
    codingWorkspaceReader,
    resolveCodingTarget,
    browserWsBase,
    ahpHost,
    requirementSvc,
    wikiSvc,
    mcpSvc,
    workflowApp,
    saveWorkflowDefinition,
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
  } = deps;

  return {
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
          await reconcileAgent(id);
        },
      },
      identityStore,
      (id: string) => larkBotRegistry.statusOf(id),
      getSetupManager,
      (id: string) => projectSvc.exists(id),
      // Skill pack symlinks resolve into `<dataDir>/skill-packs`; narrow the
      // read-only workspace viewer to ONLY that subdir so sibling secrets stay unreachable.
      [join(config.dataDir, "skill-packs")],
      larkSurfaceFactsOf,
    ),
    conversations: conversationRoutes(
      convSvc,
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
      // ADR 0075 P4b: correct a machine answer and notify the worker in its own room.
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
        opsStore.appendRunEvent(action.runId, "answer_corrected", {
          actionId,
          originalAnsweredBy: answeredBy,
          originalEvidence: action.evidence ?? [],
          correctedBy: "user",
        });
        await agentRunPort.correctActionResponse(actionId, response);
        const run = await agentRunPort.getRun(action.runId).catch(() => null);
        if (run === null) return { ok: true as const };
        await convSvc.postMessage({
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
      modelCosts: modelCostsSnapshot,
      budgetGate,
      labelResolver: entityLabels,
    }),
    coding: codingRoutes({
      registry: codingRegistry,
      resolveTarget: resolveCodingTarget,
      wsBase: browserWsBase,
      labelResolver: entityLabels,
      listWorkspaces: () => codingWorkspaceReader.listWorkspaces(),
      listActiveRuns: () => codingWorkspaceReader.listActiveRuns(),
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
    // ADR 0040: proposal adoption reuses the same service paths as HTTP routes.
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
      readWorkflowDefinition: async (workflowId) => {
        if (!/^[A-Za-z0-9._-]+$/.test(workflowId)) return null;
        const file = join(config.dataDir, "workflows", `${workflowId}.workflow.json`);
        if (!existsSync(file)) return null;
        return JSON.parse(await Bun.file(file).text());
      },
      saveWorkflowDefinition,
      updateProject: async (projectId, patch) => {
        try {
          await projectSvc.update(projectId, patch);
        } catch (err) {
          throw new ProposalNotApplicable(err instanceof Error ? err.message : String(err));
        }
      },
    }),
    auth: authRoutes(passwordSvc),
    providers: providerRoutes(providerSvc, { onChange: refreshOmaProviderEnv }),
    harnesses: harnessRoutes(harnessCatalog),
    models: modelRoutes({
      list: async () => {
        const rows = (await codingAgentCatalog.list()).models.map((m) => ({
          ...m,
          backendKind: "oma",
        }));
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
}
