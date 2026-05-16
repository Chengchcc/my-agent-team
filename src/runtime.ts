import { EventEmitter } from 'node:events';
import type { AgentConfig, Provider, AgentHooks } from './types';
import type { LLMSettings, ContextSettings, McpServerConfig, TraceSettings } from './config/types';
import { loadProfileIdentity } from './profile/loader';
import { Agent } from './agent/Agent';
import { ToolRegistry } from './agent/tool-registry';
import { ContextManager } from './agent/context';
import type { ContextManagerConfig } from './agent/context';
import { SubAgentTool } from './agent/sub-agent-tool';
import type { McpManager } from './mcp/manager';
import { setMcpManagerInstance, setMcpToolRegistry, setMcpPromptRegistry } from './mcp/index';
import { createTodoMiddleware } from './todos';
import type { SqliteMemoryStore, MemoryMiddleware } from './memory';
import { wireMemoryIntoEvolution, backfillEmbeddings } from './memory/wire-memory-evolution';
import { createSkillMiddleware } from './skills/middleware';
import { SkillLoader } from './skills/loader';
import { SessionStore } from './session/store';
import { createAutoSaveHook } from './session/hook';
import type { AskUserQuestionParameters, AskUserQuestionResult } from './tools/ask-user-question';
import type { ToolContext } from './agent/tool-dispatch/types';
import {
  BashTool, TextEditorTool, AskUserQuestionTool,
  ReadTool, GrepTool, GlobTool, LsTool, WebSearchTool, WebFetchTool,
} from './tools';
import { createProviderFromSettings } from './providers';
import { createProviderFromEnv } from './runtime-providers';
import { DEFAULT_SYSTEM_PROMPT } from './config/default-prompts';
import { debugLog } from './utils/debug';
import { PermissionMiddleware } from './agent/tool-dispatch/middlewares/permission';
import { ReadCacheMiddleware } from './agent/tool-dispatch/middlewares/read-cache';
import type { ToolMiddleware } from './agent/tool-dispatch/middleware';
import { DEFAULT_MAX_TOKENS } from './config/constants';
import type { TraceAgentMiddleware } from './trace/agent-middleware';
import { setupMemory, setupCompaction, assembleMcp, setupTrace } from './runtime-setup';

export interface RuntimeConfig {
  provider?: 'claude' | 'openai';
  model?: string;
  maxTokens?: number;
  tokenLimit?: number;
  cwd?: string;
  /** Load identity files (SOUL.md, IDENTITY.md, AGENTS.md) from this profile */
  profileId?: string;
  enableMemory?: boolean;
  enableSkills?: boolean;
  enableTodo?: boolean;
  enableSession?: boolean;
  enableCompaction?: boolean;
  systemPrompt?: string;
  allowedRoots?: string[];
  askUserQuestionHandler?: (params: AskUserQuestionParameters, context: ToolContext) => Promise<AskUserQuestionResult>;
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
  memoryStore?: SqliteMemoryStore;
  skillLoader?: SkillLoader;
  mcpManager?: McpManager;
  traceMiddleware?: TraceAgentMiddleware;
  events: EventEmitter;
  _hooks?: AgentHooks;
  _toolMiddlewares?: ToolMiddleware[];
  shutdown: () => Promise<void>;
}

export interface SessionConfig {
  enableTodo?: boolean;
  enableSession?: boolean;
  enableCompaction?: boolean;
  systemPrompt?: string;
  tokenLimit?: number;
  cwd?: string;
  model?: string;
}
// eslint-disable-next-line complexity
export async function createAgentRuntime(
  config: RuntimeConfig = {},
): Promise<AgentRuntime> {
  const {
    cwd = process.cwd(),
    profileId,
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

  const allowedRoots = allowedRootsOverride ?? settings?.security?.allowedRoots ?? [cwd];
  const effectiveSystemPrompt = profileId ? systemPrompt + '\n\n' + loadProfileIdentity(profileId) : systemPrompt;

  // Create provider - from settings or auto-detect from env
  let provider: Provider;
  try {
    if (settings) {
      provider = createProviderFromSettings(settings.llm);
    } else {
      provider = createProviderFromEnv(config);
    }
  } catch (err) {
    // J-9: Explicit throw on provider creation failure instead of silent fallback
    throw new Error(`Failed to create provider: ${String(err)}`, { cause: err });
  }

  // M-4: Model-adaptive token limit based on known model families
  const modelName = (config.model ?? settings?.llm.model ?? '').toLowerCase();
  const DEFAULT_TOKEN_LIMIT = modelAdaptiveTokenLimit(modelName);
  const tokenLimit = settings?.context.tokenLimit || DEFAULT_TOKEN_LIMIT;
  const maxTokens = settings?.llm.maxTokens || DEFAULT_MAX_TOKENS;

  // Context manager with optional tiered compaction
  const compressionStrategy = setupCompaction(enableCompaction, settings, provider, tokenLimit, maxTokens);

  const contextManagerConfig: ContextManagerConfig = {
    tokenLimit,
    defaultSystemPrompt: effectiveSystemPrompt,
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

  const defaultHeadlessHandler = async (_params: AskUserQuestionParameters, _context: ToolContext) => {
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
  const memorySetup = setupMemory(enableMemory, provider, toolRegistry, hooks, profileId);
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
    // J-10: Warn when runtime creates a default session but daemon manages per-chat sessions
    if (profileId) {
      debugLog('[runtime] enableSession=true with profileId — runtime creates default session, daemon manages per-chat sessions separately');
    }
  }

  // Build default tool middleware chain: Permission → ReadCache → tool.execute
  const toolMiddlewares: ToolMiddleware[] = [
    new PermissionMiddleware({
      denyInSubAgent: ['sub_agent', 'ask_user_question'],
    }),
    new ReadCacheMiddleware(),
  ];

  // Trace
  const { evolution, agentMiddleware } = setupTrace(settings, hooks, toolMiddlewares, skillLoader);

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
    events: new EventEmitter(),
    _hooks: hooks,
    _toolMiddlewares: toolMiddlewares,
    shutdown: async () => {
      // M-7: Dispose event listeners before shutting down subsystems
      runtime.events.removeAllListeners();
      if (mcpManager) {
        await mcpManager.shutdown();
        setMcpManagerInstance(null);
        setMcpToolRegistry(null as unknown as never);
        setMcpPromptRegistry(null);
      }
      if (memorySetup?.store) {
        await memorySetup.store.close();
      }
    },
  };
  if (memoryMiddleware) runtime.memoryMiddleware = memoryMiddleware;
  if (memorySetup?.store) runtime.memoryStore = memorySetup.store;
  if (skillLoader) runtime.skillLoader = skillLoader;
  if (mcpManager) runtime.mcpManager = mcpManager;
  if (agentMiddleware) runtime.traceMiddleware = agentMiddleware;
  return runtime;
}

const DEFAULT_SESSION_TOKEN_LIMIT = 100_000;

export function createSessionAgent(
  runtime: AgentRuntime,
  contextManager: ContextManager,
  toolRegistry: ToolRegistry,
  config: SessionConfig = {},
): Agent {
  // Register per-session todo tool if enabled
  if (config.enableTodo) {
    const { tool: todoTool, hooks: todoHooks } = createTodoMiddleware();
    toolRegistry.register(todoTool);
    // Push todo hooks to runtime's shared beforeModel hooks
    if (runtime._hooks) runtime._hooks.beforeModel?.push(todoHooks.beforeModel!);
  }

  // Create agent reusing provider, hooks, middlewares from runtime
  const agent = new Agent({
    provider: runtime.provider,
    contextManager,
    config: {
      tokenLimit: config.tokenLimit ?? DEFAULT_SESSION_TOKEN_LIMIT,
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(config.model ? { model: config.model } : {}),
    },
    toolRegistry,
    hooks: runtime._hooks ?? {},
    toolMiddlewares: runtime._toolMiddlewares ?? [],
  });

  return agent;
}

// M-4: Model-adaptive token limits
const MODEL_DEFAULT_TOKEN_LIMIT = 100_000;
const CLAUDE_TOKEN_LIMIT = 200_000;
const GPT4_TOKEN_LIMIT = 128_000;
const GPT3_5_TOKEN_LIMIT = 16_384;
const DEEPSEEK_TOKEN_LIMIT = 128_000;
const GEMINI_TOKEN_LIMIT = 1_048_576;

// M-4: Return a reasonable default token limit based on known model families
function modelAdaptiveTokenLimit(modelName: string): number {
  if (!modelName) return MODEL_DEFAULT_TOKEN_LIMIT;
  if (modelName.includes('claude')) return CLAUDE_TOKEN_LIMIT;
  if (modelName.includes('gpt-4')) return GPT4_TOKEN_LIMIT;
  if (modelName.includes('gpt-3.5')) return GPT3_5_TOKEN_LIMIT;
  if (modelName.includes('deepseek')) return DEEPSEEK_TOKEN_LIMIT;
  if (modelName.includes('gemini')) return GEMINI_TOKEN_LIMIT;
  return MODEL_DEFAULT_TOKEN_LIMIT;
}




