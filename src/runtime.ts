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
  JsonlMemoryStore, KeywordRetriever, LlmExtractor,
  MemoryMiddleware, MemoryTool,
  invalidateAgentMdCache,
} from './memory';
import { createSkillMiddleware } from './skills/middleware';
import { SkillLoader } from './skills/loader';
import { SessionStore } from './session/store';
import { createAutoSaveHook } from './session/hook';
import type { AskUserQuestionParameters, AskUserQuestionResult } from './tools/ask-user-question';
import { BashTool, TextEditorTool, AskUserQuestionTool, ReadTool, GrepTool, GlobTool, LsTool } from './tools';
import { ClaudeProvider, OpenAIProvider, createProviderFromSettings } from './providers';
import { DEFAULT_SYSTEM_PROMPT } from './config/default-prompts';
import { TokenBudgetCalculator, TieredCompactionManager, DEFAULT_COMPACTION_CONFIG } from './agent/compaction';
import { debugLog } from './utils/debug';
import { PermissionMiddleware } from './agent/tool-dispatch/middlewares/permission';
import { ReadCacheMiddleware } from './agent/tool-dispatch/middlewares/read-cache';
import type { ToolMiddleware } from './agent/tool-dispatch/middleware';
import { DEFAULT_MAX_TOKENS, DEFAULT_COMPACTION_BUFFER, DEFAULT_MODEL, DEFAULT_SUMMARY_MODEL, DEFAULT_TEMPERATURE, DEFAULT_EVOLUTION_MAX_TURNS, DEFAULT_EVOLUTION_TOKEN_LIMIT, DEFAULT_EVOLUTION_TIMEOUT_MS, DEFAULT_AUTO_ACCEPT_HOURS, DEFAULT_LOW_SCORE_THRESHOLD } from './config/constants';
import { createTraceMiddleware } from './trace';
import { initEvolution } from './evolution';
import type { EvolutionModule } from './evolution';
import { useTuiStore } from './cli/tui/state/store';

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
  const memoryMiddleware = setupMemory(enableMemory, provider, cwd, toolRegistry, hooks);

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
  setupTrace(settings, hooks, toolMiddlewares, skillLoader);

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
      if (memoryMiddleware) {
        await memoryMiddleware.awaitPendingExtractions();
      }
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
  provider: Provider,
  cwd: string,
  toolRegistry: ToolRegistry,
  hooks: { beforeModel: Middleware[]; afterAgentRun: Middleware[] },
): MemoryMiddleware | undefined {
  if (!enabled) return undefined;
  const semanticStore = new JsonlMemoryStore('semantic');
  const episodicStore = new JsonlMemoryStore('episodic');
  const projectStore = new JsonlMemoryStore('project', {}, cwd);
  const retriever = new KeywordRetriever(semanticStore, episodicStore, projectStore);
  const extractor = new LlmExtractor(provider);
  const middleware = new MemoryMiddleware(
    { semantic: semanticStore, episodic: episodicStore, project: projectStore },
    retriever, extractor,
  );
  toolRegistry.register(new MemoryTool(
    { semantic: semanticStore, episodic: episodicStore, project: projectStore },
    retriever, extractor,
  ));
  if (middleware.beforeModel) hooks.beforeModel.push(middleware.beforeModel);
  if (middleware.afterAgentRun) hooks.afterAgentRun.push(middleware.afterAgentRun);
  void semanticStore.enforceLimit?.();
  void episodicStore.enforceLimit?.();
  invalidateAgentMdCache();
  return middleware;
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

/**
 * Create provider from environment variables (headless mode fallback).
 */
function createProviderFromEnv(config: RuntimeConfig): Provider {
  const {
    provider: providerName,
    model,
    maxTokens = DEFAULT_MAX_TOKENS,
  } = config;

  const hasClaudeKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const hasOpenaiKey = !!process.env.OPENAI_API_KEY;

  // Resolve provider: explicit > auto-detect from available keys
  const resolved = providerName ?? (hasClaudeKey ? 'claude' : hasOpenaiKey ? 'openai' : null);

  if (resolved === 'claude' && hasClaudeKey) {
    return buildClaudeFromEnv(model, maxTokens);
  }
  if (resolved === 'openai' && hasOpenaiKey) {
    return buildOpenaiFromEnv(model, maxTokens);
  }

  if (providerName) {
    throw new Error(`Provider '${providerName}' not available or no API key found.`);
  }
  throw new Error('No API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
}

function buildClaudeFromEnv(model: string | undefined, maxTokens: number): ClaudeProvider {
  return new ClaudeProvider({
    apiKey: (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)!,
    model: model || process.env.MODEL || DEFAULT_MODEL,
    maxTokens,
    temperature: DEFAULT_TEMPERATURE,
    ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
  });
}

function buildOpenaiFromEnv(model: string | undefined, maxTokens: number): OpenAIProvider {
  return new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    model: model || process.env.MODEL || 'gpt-4o',
    maxTokens,
    temperature: DEFAULT_TEMPERATURE,
    ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
  });
}

function setupEvolution(settings: RuntimeConfig['settings']): EvolutionModule | null {
  const review = settings?.trace?.review;
  if (!review || review.enabled === false) return null;
  const model = review.model ?? 'claude-3-haiku-20240307';
  return initEvolution({
    enabled: true,
    model,
    maxTurns: review.maxTurns ?? DEFAULT_EVOLUTION_MAX_TURNS,
    tokenLimit: review.tokenLimit ?? DEFAULT_EVOLUTION_TOKEN_LIMIT,
    timeoutMs: review.timeoutMs ?? DEFAULT_EVOLUTION_TIMEOUT_MS,
    outputDir: review.outputDir ?? '~/.my-agent/skills/auto',
    autoAcceptHours: review.autoAcceptHours ?? DEFAULT_AUTO_ACCEPT_HOURS,
    lowScoreWarningThreshold: review.lowScoreWarningThreshold ?? DEFAULT_LOW_SCORE_THRESHOLD,
  }, createEvolutionProvider(model), (skillName, description, outputDir) => {
    useTuiStore.getState().addReviewNotification(skillName, description, outputDir);
  });
}

function setupTrace(
  settings: RuntimeConfig['settings'],
  hooks: Required<Pick<AgentHooks, 'beforeAgentRun' | 'beforeModel' | 'beforeAddResponse' | 'afterAgentRun'>>,
  toolMiddlewares: ToolMiddleware[],
  skillLoader?: SkillLoader | null,
): void {
  if (settings?.trace?.enabled === false) return;
  const evolution = setupEvolution(settings);
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
}

/**
 * Create a lightweight provider for the evolution review agent.
 * Uses the same API credentials as the main agent but with the
 * review-specific model (e.g. claude-3-haiku).
 */
function createEvolutionProvider(model: string): Provider {
  const hasClaudeKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (hasClaudeKey) {
    return new ClaudeProvider({
      apiKey: (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)!,
      model,
      maxTokens: DEFAULT_MAX_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
    });
  }
  const hasOpenaiKey = !!process.env.OPENAI_API_KEY;
  if (hasOpenaiKey) {
    return new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY!,
      model,
      maxTokens: DEFAULT_MAX_TOKENS,
      temperature: DEFAULT_TEMPERATURE,
      ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
    });
  }
  throw new Error('No API key found for evolution provider. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
}
