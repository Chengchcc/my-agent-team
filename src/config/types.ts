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

export interface MemoryLifecycleConfig {
  /** Cosine distance threshold for semantic dedup (lower = stricter). */
  semanticDedupThreshold: number;
  /** Top-K neighbours to check for contradiction. */
  contradictionTopK: number;
  /** Enable LLM-based contradiction arbitration. */
  enableContradictionMerge: boolean;
  /** Half-life in days for recency decay in retrieval scoring. */
  decayHalfLifeDays: number;
  /** Entries older than this many days are prune candidates. */
  pruneAfterDays: number;
  /** Entries with usageCount <= this are prune candidates. */
  pruneMinUsageCount: number;
}

export interface MemoryExplicitConfig {
  /** Enable the memory.remember / memory.forget tools. */
  enabled: boolean;
  /** Maximum remember calls per turn before rate-limiting. */
  perTurnLimit: number;
  /** Default weight for explicitly remembered entries. */
  defaultWeight: number;
  /** Retrieval boost multiplier for explicit-source entries. */
  explicitSourceWeightBoost: number;
}

export interface MemorySettings {
  enabled: boolean;
  globalBaseDir: string;
  maxGeneralEntries: number;
  consolidationThreshold: number;
  autoExtractMinToolCalls: number;
  maxInjectedEntries: number;
  extractionModel: string;
  retrievalThreshold: number;
  retrievalTopK: number;
  extractTriggerMode: 'explicit' | 'auto' | 'off';
  maxUserPreferences: number;
  preferenceWeightThreshold: number;
  hybridRetrieval?: HybridRetrievalConfig;
  lifecycle?: MemoryLifecycleConfig;
  explicit?: MemoryExplicitConfig;
}

interface HybridRetrievalConfig {
  enabled: boolean;
  ollamaModel: string;
  ollamaBaseUrl: string;
  vectorWeight: number;
  bm25Weight: number;
  keywordWeight: number;
}

export interface SkillsSettings {
  baseDir: string;
  /** Additional skill directories to search (beyond builtin + agent). */
  extraPaths?: string[];
  autoInject: boolean;
  injectOnMention: boolean;
  /** Maximum number of mentioned skills to inject per turn (tag matches always included). */
  maxInjectedSkills: number;
  /** Maximum length for skill descriptions before truncation (security / prompt bloat). */
  maxDescriptionLength: number;
}

interface HistorySettings {
  enabled: boolean;
  maxLines: number;
  filePath: string;
}

interface SessionSettings {
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

interface TavilySettings {
  apiKey: string | null;
}

export interface ToolsSettings {
  tavily: TavilySettings;
}

export interface DebugSettings {
  enabled: boolean;
}

export interface LogSettings {
  /** Directory for log output. Default: ~/.my-agent/profiles/<profile>/logs */
  dir?: string;
  /** Minimum log level. Default: 'info' */
  level?: 'debug' | 'info' | 'warn' | 'error';
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

export interface AutoRetireConfig {
  /** Enable stats-driven auto-retire (default: true). */
  enabled: boolean;
  /** Minimum sample size before rules activate (default: 5). */
  minSampleSize: number;
  /** Sliding window size for recent outcomes (default: 20). */
  windowSize: number;
  /** Success rate above which a skill is healthy (default: 0.5). */
  healthThreshold: number;
  /** Success rate below which to flag the skill (default: 0.3). */
  flagThreshold: number;
  /** Success rate below which to retire immediately (default: 0.15). */
  retireThreshold: number;
  /** Grace period in ms from flag to forced retire (default: 7 days). */
  flagGracePeriodMs: number;
  /** Whether user cancellations count as failures (default: true). */
  cancelCountsAsFailure: boolean;
}

export interface EvolutionSettings {
  autoRetire: AutoRetireConfig;
}

export interface JobSpawnerConfig {
  /** Spawn mode: 'spawn' (process-isolated) or 'inproc' (same-thread). */
  mode: 'spawn' | 'inproc';
  /** Per-invoke timeout in ms (default: 60_000). */
  invokeTimeoutMs: number;
  /** Maximum worker lifetime in ms before forced shutdown (default: 300_000). */
  lifetimeMs: number;
  /** Max concurrent workers (default: 2). */
  maxConcurrent: number;
}

export interface JobsSettings {
  spawner: JobSpawnerConfig;
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
  log: LogSettings;
  mcp: McpSettings;
  trace: TraceSettings;
  evolution: EvolutionSettings;
  jobs: JobsSettings;
}
