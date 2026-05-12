import type { AgentConfig, Provider, AgentHooks, Middleware } from './types';
import type { LLMSettings, ContextSettings, McpSettings, McpServerConfig, TraceSettings } from './config/types';
import { settings as globalSettings } from './config';
import { Agent } from './agent/Agent';
import { ToolRegistry } from './agent/tool-registry';
import { ContextManager } from './agent/context';
import type { ContextManagerConfig } from './agent/context';
import { SubAgentTool } from './agent/sub-agent-tool';
import { McpManager } from './mcp/manager';
import { McpToolAdapter } from './mcp/tool-adapter';
import { createMcpResourceMiddleware } from './mcp/resource-middleware';
import { McpPromptRegistry } from './mcp/prompt-registry';
import { McpListServersTool, McpAddServerTool, McpRemoveServerTool, McpReadResourceTool } from './mcp/tools';
import { setMcpManagerInstance, setMcpToolRegistry, setMcpPromptRegistry } from './mcp/index';
import { DEFAULT_MCP_TOOL_TIMEOUT_MS, DEFAULT_MCP_RECONNECT_ATTEMPTS, DEFAULT_MCP_RECONNECT_DELAY_MS } from './config/constants';
import { createTodoMiddleware } from './todos';
import {
  SqliteMemoryStore, KeywordRetriever,
  BM25Retriever, VectorRetriever, HybridRetriever,
  MemoryMiddleware, MemoryTool,
  invalidateAgentMdCache,
} from './memory';
import type { MemoryRetriever } from './memory';
import { wireMemoryIntoEvolution, backfillEmbeddings } from './memory/wire-memory-evolution';
import { createSkillMiddleware } from './skills/middleware';
import { SkillLoader } from './skills/loader';
import { SessionStore } from './session/store';
import { createAutoSaveHook } from './session/hook';
import type { AskUserQuestionParameters, AskUserQuestionResult } from './tools/ask-user-question';
import {
  BashTool, TextEditorTool, AskUserQuestionTool,
  ReadTool, GrepTool, GlobTool, LsTool, WebSearchTool, WebFetchTool,
} from './tools';
import { createProviderFromSettings } from './providers';
import { createProviderFromEnv, setupEvolution } from './runtime-providers';
import type { EvolutionModule } from './evolution';
import { DEFAULT_SYSTEM_PROMPT } from './config/default-prompts';
import { TokenBudgetCalculator, TieredCompactionManager, DEFAULT_COMPACTION_CONFIG } from './agent/compaction';
import { debugLog } from './utils/debug';
import { PermissionMiddleware } from './agent/tool-dispatch/middlewares/permission';
import { ReadCacheMiddleware } from './agent/tool-dispatch/middlewares/read-cache';
import type { ToolMiddleware } from './agent/tool-dispatch/middleware';
import { DEFAULT_MAX_TOKENS, DEFAULT_COMPACTION_BUFFER, DEFAULT_SUMMARY_MODEL } from './config/constants';
import { createTraceMiddleware } from './trace';

export interface RuntimeConfig {
  provider?: 'claude' | 'openai';
  model?: string;
  maxTokens?: number;
  tokenLimit?: number;
  cwd?: string;
  enableMemory?: boolean;
  enableSkills?: boolean;
  enableTodo?: boolean;
  enableSession?: boolean;
  enableCompaction?: boolean;
  systemPrompt?: string;
  allowedRoots?: string[];
  askUserQuestionHandler?: (params: AskUserQuestionParameters) => Promise<AskUserQuestionResult>;
  /** For TUI mode: full settings object overrides individual options */
  settings?: {
    llm: LLMSettings;
    context: ContextSettings;
    security?: { allowedRoots?: string[] };
    trace?: TraceSettings;
  };
  /** Disable MCP client (default: false, enabled if settings.mcp.enabled is true) */
  enableMcp?: boolean;
  /** Additional MCP servers from CLI (merged with settings, CLI overrides by name) */
  mcpServers?: McpServerConfig[];
}

export interface AgentRuntime {
  agent: Agent;
  provider: Provider;
  toolRegistry: ToolRegistry;
  contextManager: ContextManager;
  sessionStore: SessionStore;
  memoryMiddleware?: MemoryMiddleware;
  skillLoader?: SkillLoader;
  mcpManager?: McpManager;
  shutdown: () => Promise<void>;
}

 
// eslint-disable-next-line complexity
export async function createAgentRuntime(
  config: RuntimeConfig = {},
): Promise<AgentRuntime> {
  const {
    cwd = process.cwd(),
    enableMemory = true,
    enableSkills = true,
    enableTodo = true,
    enableSession = true,
    enableCompaction = true,
    enableMcp,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    allowedRoots: allowedRootsOverride,
    askUserQuestionHandler,
    settings,
  } = config;

  // Resolve allowedRoots: settings.security.allowedRoots → explicit override → cwd
  const allowedRoots = allowedRootsOverride
    ?? settings?.security?.allowedRoots
    ?? [cwd];

  // Create provider - from settings or auto-detect from env
  let provider: Provider;
  if (settings) {
    provider = createProviderFromSettings(settings.llm);
  } else {
    provider = createProviderFromEnv(config);
  }

  // Token limit - from settings or default
  const DEFAULT_TOKEN_LIMIT = 100_000;
  const tokenLimit = settings?.context.tokenLimit || DEFAULT_TOKEN_LIMIT;
  const maxTokens = settings?.llm.maxTokens || DEFAULT_MAX_TOKENS;

  // Context manager with optional tiered compaction
  const compressionStrategy = setupCompaction(enableCompaction, settings, provider, tokenLimit, maxTokens);

  const contextManagerConfig: ContextManagerConfig = {
    tokenLimit,
    defaultSystemPrompt: systemPrompt,
  };
  if (compressionStrategy) contextManagerConfig.compressionStrategy = compressionStrategy;
  const contextManager = new ContextManager(contextManagerConfig);

  const agentConfig: AgentConfig = { tokenLimit };

  // Tool registry with security boundaries
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(new BashTool({ allowedWorkingDirs: allowedRoots }));
  toolRegistry.register(new TextEditorTool(allowedRoots));
  toolRegistry.register(new ReadTool());
  toolRegistry.register(new GrepTool());
  toolRegistry.register(new GlobTool());
  toolRegistry.register(new LsTool());

  // WebSearch — always registered; API key resolved lazily at call time
  toolRegistry.register(new WebSearchTool());

  // WebFetch — always registered; API key resolved lazily at call time
  toolRegistry.register(new WebFetchTool());

  const defaultHeadlessHandler = async () => {
    throw new Error('ask_user_question tool is not available in headless mode');
  };
  toolRegistry.register(new AskUserQuestionTool(
    askUserQuestionHandler ?? defaultHeadlessHandler,
  ));

  const hooks: Required<Pick<AgentHooks, 'beforeAgentRun' | 'beforeModel' | 'beforeAddResponse' | 'afterAgentRun'>> = {
    beforeAgentRun: [],
    beforeModel: [],
    beforeAddResponse: [],
    afterAgentRun: [],
  };

  // Todo
  if (enableTodo) {
    const { tool: todoTool, hooks: todoHooks } = createTodoMiddleware();
    toolRegistry.register(todoTool);
    if (todoHooks.beforeModel) hooks.beforeModel.push(todoHooks.beforeModel);
  }

  // Sub Agent (hooks.beforeModel passed by reference — populated by middleware below)
  toolRegistry.register(new SubAgentTool({
    mainProvider: provider,
    mainToolRegistry: toolRegistry,
    mainAgentConfig: agentConfig,
    hooks: { beforeModel: hooks.beforeModel },
  }));

  // MCP Client
  const { mcpManager } = await assembleMcp(
    enableMcp,
    config.mcpServers,
    toolRegistry,
    hooks,
  );

  // Memory
  const memorySetup = setupMemory(enableMemory, provider, toolRegistry, hooks);
  const memoryMiddleware = memorySetup?.middleware;

  // Skills
  let skillMiddleware: ReturnType<typeof createSkillMiddleware> | undefined;
  let skillLoader: SkillLoader | undefined;
  if (enableSkills) {
    skillLoader = new SkillLoader();
    skillMiddleware = createSkillMiddleware({ skillLoader, autoInject: true, injectOnMention: true });
    hooks.beforeAgentRun.push(skillMiddleware.beforeAgentRun);
    hooks.beforeModel.push(skillMiddleware.beforeModel);
    await skillMiddleware.preloadAll();
  }

  // Session
  const sessionStore = new SessionStore();
  if (enableSession) {
    await sessionStore.ensureSessionDir();
    sessionStore.createNewSession();
    hooks.afterAgentRun.push(createAutoSaveHook(sessionStore));
  }

  // Build default tool middleware chain: Permission → ReadCache → tool.execute
  const toolMiddlewares: ToolMiddleware[] = [
    new PermissionMiddleware({
      denyInSubAgent: ['sub_agent', 'ask_user_question'],
    }),
    new ReadCacheMiddleware(),
  ];

  // Trace
  const evolution = setupTrace(settings, hooks, toolMiddlewares, skillLoader);

  // Wire memory extraction/embedding dispatchers into evolution drainer
  if (evolution && memorySetup) {
    wireMemoryIntoEvolution(evolution, memorySetup, provider);
    void backfillEmbeddings(memorySetup.store, evolution.queue);
  }

  // Agent
  const agent = new Agent({
    provider,
    contextManager,
    config: agentConfig,
    toolRegistry,
    hooks,
    toolMiddlewares,
  });

  const runtime: AgentRuntime = {
    agent,
    provider,
    toolRegistry,
    contextManager,
    sessionStore,
    shutdown: async () => {
      if (mcpManager) {
        await mcpManager.shutdown();
        setMcpManagerInstance(null);
        setMcpToolRegistry(null as unknown as never);
        setMcpPromptRegistry(null);
      }
    },
  };
  if (memoryMiddleware) runtime.memoryMiddleware = memoryMiddleware;
  if (skillLoader) runtime.skillLoader = skillLoader;
  if (mcpManager) runtime.mcpManager = mcpManager;
  return runtime;
}

function setupMemory(
  enabled: boolean,
  _provider: Provider,
  toolRegistry: ToolRegistry,
  hooks: { beforeModel: Middleware[]; afterAgentRun: Middleware[] },
): { middleware: MemoryMiddleware; store: SqliteMemoryStore; retriever: MemoryRetriever } | undefined {
  if (!enabled) return undefined;
  const generalStore = new SqliteMemoryStore('general');
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

function setupCompaction(
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

async function assembleMcp(
  enableMcp: boolean | undefined,
  cliServers: McpServerConfig[] | undefined,
  toolRegistry: ToolRegistry,
  hooks: AgentHooks,
): Promise<{ mcpManager?: McpManager; mcpPromptRegistry?: McpPromptRegistry }> {
  if (enableMcp === false) return {};

  let mcpSettings: McpSettings;
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

function setupTrace(
  settings: RuntimeConfig['settings'],
  hooks: Required<Pick<AgentHooks, 'beforeAgentRun' | 'beforeModel' | 'beforeAddResponse' | 'afterAgentRun'>>,
  toolMiddlewares: ToolMiddleware[],
  skillLoader?: SkillLoader | null,
): EvolutionModule | null {
  if (settings?.trace?.enabled === false) return null;
  const evolution = setupEvolution(settings);
  if (!evolution) return null;
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
  return evolution;
}

