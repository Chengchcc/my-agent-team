import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { resolveModelAlias } from "@chengchenccc/ai";
import type { EmbeddingProvider } from "@chengchenccc/embedding";
import type { BackendConfig } from "../config.js";
import type { AgentService } from "../features/agent/index.js";
import { createBudgetGate, resolveRunWorkspace } from "../features/agent-run/index.js";
import type { AgentRunPort } from "../features/agent-run/ports.js";
import {
  type ConversationPort,
  deriveConversationTitle,
  firstUserText,
} from "../features/conversation/index.js";
import { createEmbeddingClient } from "../features/embedding-client.js";
import type { createOmaModelCatalog } from "../features/models/index.js";
import type { ProjectService } from "../features/project/index.js";
import { ensureRequirementWorktree } from "../features/project/requirement-workspace.js";
import { ensureMirror } from "../features/project/worktree.js";
import { createMemoryRecall } from "../features/recall/memory-recall.js";
import type { RequirementService } from "../features/requirement/index.js";
import type { SettingsService } from "../features/settings/index.js";
import { createWorkspaceService } from "../features/workspace/service.js";

export interface WorkspaceAndRecallDeps {
  config: BackendConfig;
  db: Database;
  ulid: () => string;
  agentSvc: AgentService;
  convPort: ConversationPort;
  agentRunPort: AgentRunPort;
  requirementSvc: RequirementService;
  settingsSvc: SettingsService;
  codingAgentCatalog: ReturnType<typeof createOmaModelCatalog>;
  getProjectSvc: () => ProjectService;
}

/** Wire ADR 0077 requirement-owned workspaces, run workspace resolution,
 *  model cost pricing snapshot, daily budget gate, and memory recall. */
export function wireWorkspaceAndRecall(deps: WorkspaceAndRecallDeps) {
  const {
    config,
    db,
    ulid,
    agentSvc,
    convPort,
    agentRunPort,
    requirementSvc,
    settingsSvc,
    codingAgentCatalog,
    getProjectSvc,
  } = deps;

  const workspaceSvc = createWorkspaceService({
    db,
    idGen: ulid,
    materialize: async ({ projectId, requirementId }) => {
      const project = getProjectSvc().getById(projectId);
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

  const checkoutOf = (
    conversationId: string,
  ): {
    requirementId: string | null;
    projectId: string | null;
    checkout: { path: string } | null;
  } => {
    const convRow = convPort.getConversation(conversationId);
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
      conversationProjectId: checkout === null ? null : projectId,
      requirementWorkspacePath: checkout?.path ?? null,
    });
  };

  const workspaceForRun = async (input: {
    conversationId: string;
    agentId?: string | null;
    runId?: string;
  }): Promise<{ root: string; access: "read_write" }> => {
    const agent = input.agentId ? await agentSvc.getById(input.agentId).catch(() => null) : null;
    const convRow = convPort.getConversation(input.conversationId);
    const current = checkoutOf(input.conversationId);
    let requirementId = current.requirementId;
    const projectId = current.projectId;
    const isWorker = agent?.config.role === "worker";
    if (isWorker && projectId !== null && requirementId === null) {
      const project = getProjectSvc().getById(projectId);
      const asked = deriveConversationTitle(
        firstUserText(convPort.getLedgerEntries(input.conversationId)),
      );
      const title =
        (convRow?.title ?? "").trim().slice(0, 80) ||
        asked ||
        (project ? `${project.name} — work opened from this room` : "Work opened from this room");
      const opened = requirementSvc.create({
        title,
        goal: "Opened by the product when work started in this room.",
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
    if (input.runId !== undefined && requirementId !== null) {
      const row = await agentRunPort.getRun(input.runId).catch(() => null);
      if (row !== null && row.requirementId === null) {
        agentRunPort.setRequirementId?.(input.runId, requirementId);
      }
    }
    const checkout =
      isWorker && requirementId !== null && projectId !== null
        ? await workspaceSvc.ensureForRequirement({ requirementId, projectId })
        : null;
    return resolveRunWorkspace({
      agentId: input.agentId ?? null,
      agentWorkspacePath: agent?.workspacePath ?? null,
      fallbackRoot: config.workspaceRoot,
      conversationProjectId: isWorker ? projectId : null,
      requirementWorkspacePath: checkout?.path ?? null,
    });
  };

  const modelCostsSnapshot = (async () => {
    const map = new Map<
      string,
      { input: number; output: number; cacheRead: number; cacheWrite: number }
    >();
    for (const m of (await codingAgentCatalog.list()).models) {
      map.set(resolveModelAlias(m.id), m.cost);
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
      const convRow = convPort.getConversation(conversationId);
      if (!convRow?.agentId) return null;
      const ws = await peekWorkspaceFor({
        conversationId,
        agentId: convRow.agentId,
      }).catch(() => null);
      return ws?.root ?? null;
    },
    embedding: embeddingProviderForRecall(),
  });

  return {
    workspaceSvc,
    checkoutOf,
    peekWorkspaceFor,
    workspaceForRun,
    modelCostsSnapshot,
    budgetGate,
    memoryRecall,
  };
}
