import type { Database } from "bun:sqlite";
import type { McpClientManager } from "@chengchenccc/adapter-mcp";
import type { BackendConfig } from "../config.js";
import type { AgentService } from "../features/agent/index.js";
import {
  extractMcpSecrets,
  type McpServerEntry,
  reconcileAgentResources,
} from "../features/agent/workspace-bridge.js";
import { buildHistoryTools } from "../features/agent-run/index.js";
import type { ConversationPort } from "../features/conversation/index.js";
import {
  CliSetupProvisioner,
  createLarkSetupStore,
  type LarkBotRegistry,
  LarkSetupManager,
  probeCliSetupCapability,
} from "../features/lark-bot/index.js";
import {
  createMcpService,
  fileMcpServerAdapter,
  type McpRuntimeStatusStore,
} from "../features/mcp/index.js";
import { createProjectService, sqliteProjectAdapter } from "../features/project/index.js";
import { createRuntimeOpsService, type RuntimeOpsStore } from "../features/runtime-ops/index.js";
import {
  BUILTIN_PACK_ID,
  installPath,
  resolveBuiltinSkillsDirForRole,
  type SkillPackPort,
} from "../features/skill-pack/index.js";
import type { EntityLabelResolver } from "../infra/entity-labels.js";
import { sseUrlEndpoint } from "../infra/sse-url.js";

export interface OpsAndMcpWiringDeps {
  config: BackendConfig;
  db: Database;
  ulid: () => string;
  agentSvc: AgentService;
  convPort: ConversationPort;
  skillPackPort: SkillPackPort;
  larkBotRegistry: LarkBotRegistry;
  opsStore: RuntimeOpsStore;
  mcpClientManager: McpClientManager;
  mcpRuntimeStatus: McpRuntimeStatusStore;
  entityLabels: EntityLabelResolver;
  enabledMcpServers: ReadonlySet<string>;
  getWorkflowMcpUrl: () => string | null;
  getAgentConfigMcpUrl: () => string | null;
}

/** Wire Lark setup manager, live RuntimeOps, Project service, MCP catalog +
 *  workspace bridge, and per-agent resource reconciliation. */
export function wireOpsAndMcp(deps: OpsAndMcpWiringDeps) {
  const {
    config,
    db,
    ulid,
    agentSvc,
    convPort,
    skillPackPort,
    larkBotRegistry,
    opsStore,
    mcpClientManager,
    mcpRuntimeStatus,
    entityLabels,
    enabledMcpServers,
    getWorkflowMcpUrl,
    getAgentConfigMcpUrl,
  } = deps;

  let setupManager: LarkSetupManager | undefined;
  function getSetupManager(provisioner = new CliSetupProvisioner()): LarkSetupManager {
    if (!setupManager) {
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

  // Live agent name lookup via entityLabels (replaces stale boot-time agentNames Map).
  const opsSvc = createRuntimeOpsService({
    opsStore,
    getAgentName: (agentId: string) => entityLabels.labelsFor({ agentId })?.agentName,
    dbPath: `${config.dataDir}/backend.db`,
  });

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

  const projectPort = sqliteProjectAdapter(db);
  const projectSvc = createProjectService({
    port: projectPort,
    hasProjectBinding: (pid: string) => convPort.hasProjectBinding?.(pid) ?? false,
    idGen: ulid,
    listAgentConfigs: async () =>
      (await agentSvc.list(true)).map((a) => ({
        id: a.id,
        projects: a.config.runtime_config.projects,
      })),
  });

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

  async function agentIdsWithMcpServer(serverId: string): Promise<string[]> {
    const all = await agentSvc.list();
    const ids: string[] = [];
    for (const agent of all) {
      if ((await mcpSvcRaw.listAssignments(agent.id)).some((a) => a.serverId === serverId)) {
        ids.push(agent.id);
      }
    }
    return ids;
  }

  async function prepareMcpBridge(agentId: string) {
    const agent = await agentSvc.getById(agentId);
    const isWorker = agent.config.role === "worker";
    const userServers: McpServerEntry[] = (await mcpSvc.listForAgent(agentId)).map((s) => ({
      name: s.name,
      transport: s.transport,
      url: s.url,
      command: s.command,
      args: s.args ?? [],
      env: s.env ?? {},
      headers: s.headers ?? {},
    }));
    const extracted = extractMcpSecrets(userServers);
    const workflowUrl = getWorkflowMcpUrl();
    const agentConfigUrl = getAgentConfigMcpUrl();
    const servers: McpServerEntry[] = [
      ...extracted.servers,
      ...(config.productToolsMcpUrl && enabledMcpServers.has("product-tools")
        ? [
            {
              name: "product-tools",
              transport: "sse" as const,
              url: sseUrlEndpoint(config.productToolsMcpUrl),
              bearerTokenEnv: "PRODUCT_TOOLS_RUN_TOKEN",
              timeoutMs: config.askTimeoutMs + 60_000,
            },
          ]
        : []),
      ...(workflowUrl
        ? [
            {
              name: "workflow",
              transport: "sse" as const,
              url: workflowUrl,
              bearerTokenEnv: "PRODUCT_TOOLS_RUN_TOKEN",
            },
          ]
        : []),
      ...(agentConfigUrl && !isWorker
        ? [
            {
              name: "agent-config",
              transport: "sse" as const,
              url: agentConfigUrl,
              bearerTokenEnv: "PRODUCT_TOOLS_RUN_TOKEN",
            },
          ]
        : []),
    ];
    return { servers, env: extracted.env, expandableVars: extracted.expandableVars };
  }

  async function bridgeMcpServers(agentId: string): Promise<McpServerEntry[]> {
    return (await prepareMcpBridge(agentId)).servers;
  }

  function productToolsManifest(): readonly unknown[] {
    return config.productToolsMcpUrl
      ? [...buildHistoryTools(`sse:${sseUrlEndpoint(config.productToolsMcpUrl)}`)]
      : [];
  }

  const reconcileAgent = async (agentId: string): Promise<void> => {
    try {
      const agent = await agentSvc.getById(agentId);
      const packs = await skillPackPort.listForAgent(agentId);
      const agentRole = agent.config.role === "worker" ? "worker" : "front";
      const builtinRoleDir = resolveBuiltinSkillsDirForRole(
        config.dataDir,
        config.builtinSkillsDir,
        agentRole,
      );
      reconcileAgentResources({
        extraRoots: [],
        workspacePath: agent.workspacePath,
        kind: agent.config.runtime_config.harness,
        skillPacks: packs
          .filter((p) => p.status === "ready")
          .map((p) => ({
            id: p.id,
            source: p.id === BUILTIN_PACK_ID ? builtinRoleDir : installPath(config.dataDir, p.id),
          })),
        mcpServers: await bridgeMcpServers(agentId),
        productTools: productToolsManifest(),
      });
    } catch (err) {
      console.error(`[bridge] reconcile failed for ${agentId}:`, err);
    }
  };

  const mcpSvc: ReturnType<typeof createMcpService> = {
    ...mcpSvcRaw,
    async create(input) {
      return await mcpSvcRaw.create(input);
    },
    async update(serverId, input) {
      const row = await mcpSvcRaw.update(serverId, input);
      for (const agentId of await agentIdsWithMcpServer(serverId)) {
        await reconcileAgent(agentId);
      }
      return row;
    },
    async delete(serverId) {
      const affected = await agentIdsWithMcpServer(serverId);
      await mcpSvcRaw.delete(serverId);
      for (const agentId of affected) await reconcileAgent(agentId);
    },
    async setAgentServers(agentId, entries) {
      await mcpSvcRaw.setAgentServers(agentId, entries);
      await reconcileAgent(agentId);
    },
  };

  return {
    getSetupManager,
    disposeSetupManager: () => setupManager?.dispose(),
    opsSvc,
    larkSurfaceFactsOf,
    projectPort,
    projectSvc,
    mcpSvc,
    prepareMcpBridge,
    bridgeMcpServers,
    productToolsManifest,
    reconcileAgent,
  };
}
