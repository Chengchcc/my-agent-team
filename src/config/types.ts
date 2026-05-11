export const CURRENT_CONFIG_VERSION = 1;

export interface ThinkingSettings {
  /** Enable extended thinking / reasoning. */
  enabled: boolean;
  /** Budget for thinking tokens (Anthropic native: budget_tokens). */
  budgetTokens: number;
  /** Decoder type for handling different thinking protocols. */
  decoder?: 'anthropic' | 'reasoning-content';
}

export interface LLMSettings {
  provider: 'claude' | 'openai';
  model: string;
  maxTokens: number;
  temperature: number;
  apiKey: string | null;
  baseURL: string | null;
  /** Extended thinking / reasoning configuration. */
  thinking?: ThinkingSettings;
}

export interface CompactionSettings {
  enabled?: boolean;
  snipRatio?: number;
  autoCompactRatio?: number;
  collapseRatio?: number;
  toolOutputSnipThreshold?: number;
  preserveRecentTurns?: number;
  summaryModel?: string;
  maxSummaryTokens?: number;
  enabledTiers?: {
    snip?: boolean;
    autoCompact?: boolean;
    reactiveRecovery?: boolean;
    collapse?: boolean;
  };
}

export interface ContextSettings {
  tokenLimit: number;
  budgetGuard?: {
    enabled?: boolean;
    delegateThreshold?: number;
    compactThreshold?: number;
    batchOutputRatio?: number;
    minReadCallsForBatch?: number;
  };
  compaction?: CompactionSettings;
}

export interface MemorySettings {
  enabled: boolean;
  globalBaseDir: string;
  maxSemanticEntries: number;
  maxEpisodicEntries: number;
  consolidationThreshold: number;
  autoExtractMinToolCalls: number;
  maxInjectedEntries: number;
  extractionModel: string;
  retrievalThreshold: number;
  retrievalTopK: number;
  extractTriggerMode: 'explicit' | 'auto' | 'off';
  maxUserPreferences: number;
  hybridRetrieval?: HybridRetrievalConfig;
}

export interface HybridRetrievalConfig {
  enabled: boolean;
  ollamaModel: string;
  ollamaBaseUrl: string;
  vectorWeight: number;
  bm25Weight: number;
  keywordWeight: number;
}

export interface SkillsSettings {
  baseDir: string;
  autoInject: boolean;
  injectOnMention: boolean;
  /** Maximum number of mentioned skills to inject per turn (tag matches always included). */
  maxInjectedSkills: number;
  /** Maximum length for skill descriptions before truncation (security / prompt bloat). */
  maxDescriptionLength: number;
}

export interface HistorySettings {
  enabled: boolean;
  maxLines: number;
  filePath: string;
}

export interface SessionSettings {
  dir: string;
}

export interface TUISettings {
  history: HistorySettings;
  sessions: SessionSettings;
}

export interface SubAgentSettings {
  enabled: boolean;
  autoTriggerThreshold: number;
  isolation: boolean;
  worktreeRootDir: string;
}

export interface SecuritySettings {
  allowedRoots: string[];
}

export interface McpServerConfig {
  /** Unique server name, used for tool prefix generation */
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  /** stdio transport */
  command?: string;
  args?: string[];
  /** SSE / Streamable HTTP transport */
  url?: string;
  headers?: Record<string, string>;
  /** Environment variables injected to child process */
  env?: Record<string, string>;
  /** Automatically connect at agent startup (default: true) */
  autoStart?: boolean;
}

export interface McpSettings {
  enabled: boolean;
  servers: McpServerConfig[];
  /** Per-tool call timeout in ms */
  toolTimeoutMs: number;
  /** Max reconnection attempts on failure */
  reconnectAttempts: number;
  /** Base delay between reconnection attempts in ms */
  reconnectDelayMs: number;
}

export interface TavilySettings {
  apiKey: string | null;
}

export interface ToolsSettings {
  tavily: TavilySettings;
}

export interface DebugSettings {
  enabled: boolean;
}

export interface TraceRedactionSettings {
  mode: 'default' | 'none';
}

export interface TraceNudgeSettings {
  enabled: boolean;
  reviewInterval: number;
}

export interface TraceReviewSettings {
  enabled: boolean;
  model: string;
  maxTurns: number;
  tokenLimit: number;
  timeoutMs: number;
  outputDir: string;
  autoAcceptHours: number;
  lowScoreWarningThreshold: number;
}

export interface TraceSettings {
  enabled: boolean;
  maxRunsPerSession: number;
  redaction: TraceRedactionSettings;
  nudge: TraceNudgeSettings;
  review: TraceReviewSettings;
}

export interface Settings {
  llm: LLMSettings;
  context: ContextSettings;
  memory: MemorySettings;
  skills: SkillsSettings;
  tui: TUISettings;
  subAgent: SubAgentSettings;
  security: SecuritySettings;
  tools: ToolsSettings;
  debug: DebugSettings;
  mcp: McpSettings;
  trace: TraceSettings;
}
