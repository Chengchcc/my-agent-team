import type { RuntimeConfig } from './runtime';
import type { Provider, AgentHooks, Middleware } from './types';
import type { McpServerConfig } from './config/types';
import type { ToolRegistry } from './agent/tool-registry';
import {
  SqliteMemoryStore, KeywordRetriever,
  BM25Retriever, VectorRetriever, HybridRetriever,
  MemoryMiddleware, MemoryTool,
  invalidateAgentMdCache,
} from './memory';
import type { MemoryRetriever } from './memory';
import { McpManager } from './mcp/manager';
import { McpToolAdapter } from './mcp/tool-adapter';
import { createMcpResourceMiddleware } from './mcp/resource-middleware';
import { McpPromptRegistry } from './mcp/prompt-registry';
import { McpListServersTool, McpAddServerTool, McpRemoveServerTool, McpReadResourceTool } from './mcp/tools';
import { setMcpManagerInstance, setMcpToolRegistry, setMcpPromptRegistry } from './mcp/index';
import {
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  DEFAULT_MCP_RECONNECT_ATTEMPTS,
  DEFAULT_MCP_RECONNECT_DELAY_MS,
  DEFAULT_COMPACTION_BUFFER,
  DEFAULT_SUMMARY_MODEL,
} from './config/constants';
import { TokenBudgetCalculator, TieredCompactionManager, DEFAULT_COMPACTION_CONFIG } from './agent/compaction';
import { settings as globalSettings } from './config';
import { debugLog } from './utils/debug';
import { createTraceMiddleware } from './trace';
import type { TraceAgentMiddleware } from './trace/agent-middleware';
import type { EvolutionModule } from './evolution';
import type { ToolMiddleware } from './agent/tool-dispatch/middleware';
import type { SkillLoader } from './skills/loader';
import { setupEvolution } from './runtime-providers';

function sanitizeNamespace(raw: string): string {
  if (raw.includes('/') || raw.includes('\\') || raw.includes('..')) {
    throw new Error(`Invalid profileId for memory namespace: ${raw}`);
  }
  return `profile-${raw}`;
}

export function setupMemory(
  enabled: boolean,
  _provider: Provider,
  toolRegistry: ToolRegistry,
  hooks: { beforeModel: Middleware[]; afterAgentRun: Middleware[] },
  profileId?: string,
): { middleware: MemoryMiddleware; store: SqliteMemoryStore; retriever: MemoryRetriever } | undefined {
  if (!enabled) return undefined;
  const namespace = profileId ? sanitizeNamespace(profileId) : 'general';
  const generalStore = new SqliteMemoryStore(namespace as 'general');
  const keywordRetriever = new KeywordRetriever(generalStore);
  const bm25Retriever = new BM25Retriever(generalStore);
  const vectorRetriever = new VectorRetriever(generalStore);
  const retriever = new HybridRetriever(keywordRetriever, bm25Retriever, vectorRetriever);
  const middleware = new MemoryMiddleware(
    { general: generalStore },
    retriever,
  );
  toolRegistry.register(new MemoryTool(generalStore, retriever));
  if (middleware.beforeModel) hooks.beforeModel.push(middleware.beforeModel);
  void generalStore.enforceLimit?.();
  invalidateAgentMdCache();
  return { middleware, store: generalStore, retriever };
}

export function setupCompaction(
  enableCompaction: boolean,
  configSettings: RuntimeConfig['settings'],
  provider: Provider,
  tokenLimit: number,
  maxTokens: number,
): TieredCompactionManager | undefined {
  if (!enableCompaction || !configSettings?.context.compaction) return undefined;
  const tokenBudgetCalc = new TokenBudgetCalculator(tokenLimit, maxTokens, DEFAULT_COMPACTION_BUFFER);
  const compactionConfig = {
    ...DEFAULT_COMPACTION_CONFIG,
    thresholds: { ...DEFAULT_COMPACTION_CONFIG.thresholds, ...configSettings.context.compaction },
    summaryProvider: provider,
    summaryModel: configSettings.context.compaction.summaryModel || DEFAULT_SUMMARY_MODEL,
  };
  debugLog('Tiered compaction enabled');
  return new TieredCompactionManager(tokenBudgetCalc, compactionConfig);
}

export async function assembleMcp(
  enableMcp: boolean | undefined,
  cliServers: McpServerConfig[] | undefined,
  toolRegistry: ToolRegistry,
  hooks: AgentHooks,
): Promise<{ mcpManager?: McpManager; mcpPromptRegistry?: McpPromptRegistry }> {
  if (enableMcp === false) return {};

  let mcpSettings;
  try {
    mcpSettings = globalSettings.mcp;
  } catch {
    mcpSettings = {
      enabled: false,
      servers: [],
      toolTimeoutMs: DEFAULT_MCP_TOOL_TIMEOUT_MS,
      reconnectAttempts: DEFAULT_MCP_RECONNECT_ATTEMPTS,
      reconnectDelayMs: DEFAULT_MCP_RECONNECT_DELAY_MS,
    };
  }

  // Merge: CLI servers override settings servers by name
  const mergedServers = [...mcpSettings.servers];
  for (const cliServer of cliServers ?? []) {
    const idx = mergedServers.findIndex(s => s.name === cliServer.name);
    if (idx >= 0) {
      mergedServers[idx] = cliServer;
    } else {
      mergedServers.push(cliServer);
    }
  }

  if (!mcpSettings.enabled && mergedServers.length === 0) return {};

  const mcpManager = new McpManager({
    toolTimeoutMs: mcpSettings.toolTimeoutMs,
    reconnectAttempts: mcpSettings.reconnectAttempts,
    reconnectDelayMs: mcpSettings.reconnectDelayMs,
    maxReconnectAttempts: mcpSettings.reconnectAttempts,
  });

  setMcpManagerInstance(mcpManager);
  setMcpToolRegistry(toolRegistry);

  const mcpPromptRegistry = new McpPromptRegistry(mcpManager);
  setMcpPromptRegistry(mcpPromptRegistry);

  // Register management tools immediately (they work without connected servers)
  toolRegistry.register(new McpListServersTool(mcpManager));
  toolRegistry.register(new McpAddServerTool(mcpManager, toolRegistry, mcpPromptRegistry));
  toolRegistry.register(new McpRemoveServerTool(mcpManager, toolRegistry));
  toolRegistry.register(new McpReadResourceTool(mcpManager));

  // Start connections in background — don't block TUI startup
  mcpManager.onReady(() => {
    for (const { serverName, tool: toolDef } of mcpManager.getAllTools()) {
      toolRegistry.register(new McpToolAdapter(mcpManager, serverName, toolDef));
    }

    for (const { serverName, prompt: promptDef } of mcpManager.getAllPrompts()) {
      mcpPromptRegistry.registerAsTool(serverName, promptDef, toolRegistry);
    }

    const resourceMiddleware = createMcpResourceMiddleware(mcpManager);
    if (resourceMiddleware.beforeModel) {
      hooks.beforeModel?.push(resourceMiddleware.beforeModel);
    }

    debugLog('MCP initialized');
  });

  mcpManager.start(mergedServers);

  return { mcpManager, mcpPromptRegistry };
}

export function setupTrace(
  settings: RuntimeConfig['settings'],
  hooks: Required<Pick<AgentHooks, 'beforeAgentRun' | 'beforeModel' | 'beforeAddResponse' | 'afterAgentRun'>>,
  toolMiddlewares: ToolMiddleware[],
  skillLoader?: SkillLoader | null,
): { evolution: EvolutionModule | null; agentMiddleware: TraceAgentMiddleware | undefined } {
  if (!settings) {
    debugLog('[trace] settings not provided, evolution and trace disabled');
    return { evolution: null, agentMiddleware: undefined };
  }
  if (settings.trace?.enabled === false) return { evolution: null, agentMiddleware: undefined };
  const evolution = setupEvolution(settings);
  if (!evolution) return { evolution: null, agentMiddleware: undefined };
  const traceMw = createTraceMiddleware({
    maxRunsPerSession: settings?.trace?.maxRunsPerSession,
    redactionMode: settings?.trace?.redaction?.mode,
    nudgeEnabled: settings?.trace?.nudge?.enabled,
    reviewInterval: settings?.trace?.nudge?.reviewInterval,
    evolution,
    skillLoader,
  });
  hooks.beforeAgentRun.unshift(traceMw.agentMiddleware.beforeAgentRun);
  hooks.beforeAddResponse.push(traceMw.agentMiddleware.beforeAddResponse);
  hooks.afterAgentRun.push(traceMw.agentMiddleware.afterAgentRun);
  toolMiddlewares.push(traceMw.toolMiddleware);
  return { evolution, agentMiddleware: traceMw.agentMiddleware };
}
