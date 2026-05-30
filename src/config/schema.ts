import { z } from 'zod';

const llmSettingsSchema = z.object({
  provider: z.enum(['claude', 'openai']).default('claude'),
  model: z.string().default('claude-3-5-sonnet-20241022'),
  maxTokens: z.number().int().positive().default(4096),
  temperature: z.number().min(0).max(2).default(0.7),
  apiKey: z.string().nullable().default(null),
  baseURL: z.string().nullable().default(null),
});

const compactionSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  snipRatio: z.number().min(0).max(1).default(0.60),
  autoCompactRatio: z.number().min(0).max(1).default(0.75),
  collapseRatio: z.number().min(0).max(1).default(0.95),
  toolOutputSnipThreshold: z.number().int().positive().default(8000),
  preserveRecentTurns: z.number().int().positive().default(4),
  summaryModel: z.string().default('claude-3-5-haiku-20241022'),
  maxSummaryTokens: z.number().int().positive().default(1024),
  enabledTiers: z.object({
    snip: z.boolean().default(true),
    autoCompact: z.boolean().default(true),
    reactiveRecovery: z.boolean().default(true),
    collapse: z.boolean().default(true),
  }).default({
    snip: true,
    autoCompact: true,
    reactiveRecovery: true,
    collapse: true,
  }),
});

const contextSettingsSchema = z.object({
  tokenLimit: z.number().int().positive().default(180000),
  compaction: compactionSettingsSchema.optional(),
});

const hybridRetrievalConfigSchema = z.object({
  enabled: z.boolean().default(true),
  ollamaModel: z.string().default('nomic-embed-text'),
  ollamaBaseUrl: z.string().default('http://localhost:11434'),
  vectorWeight: z.number().min(0).max(1).default(0.5),
  bm25Weight: z.number().min(0).max(1).default(0.3),
  keywordWeight: z.number().min(0).max(1).default(0.2),
});

const memoryLifecycleConfigSchema = z.object({
  semanticDedupThreshold: z.number().min(0).max(1).default(0.12),
  contradictionTopK: z.number().int().positive().default(3),
  enableContradictionMerge: z.boolean().default(true),
  decayHalfLifeDays: z.number().positive().default(30),
  pruneAfterDays: z.number().positive().default(180),
  pruneMinUsageCount: z.number().int().min(0).default(0),
});

const memoryExplicitConfigSchema = z.object({
  enabled: z.boolean().default(true),
  perTurnLimit: z.number().int().positive().default(5),
  defaultWeight: z.number().min(0.1).max(1.0).default(0.6),
  explicitSourceWeightBoost: z.number().min(1.0).max(3.0).default(1.2),
});

const memorySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  globalBaseDir: z.string().default('~/.my-agent/memory'), // Deprecated — now derived from AgentPaths
  maxGeneralEntries: z.number().int().positive().default(500),
  consolidationThreshold: z.number().int().positive().default(50),
  autoExtractMinToolCalls: z.number().int().positive().default(3),
  maxInjectedEntries: z.number().int().positive().default(10),
  extractionModel: z.string().default('claude-3-haiku-20240307'),
  retrievalThreshold: z.number().min(0).max(1).default(0.75),
  retrievalTopK: z.number().int().positive().default(5),
  extractTriggerMode: z.enum(['explicit', 'auto', 'off']).default('explicit'),
  maxUserPreferences: z.number().int().positive().default(20),
  preferenceWeightThreshold: z.number().min(0).max(1).default(0.9),
  hybridRetrieval: hybridRetrievalConfigSchema.optional().default({}),
  lifecycle: memoryLifecycleConfigSchema.optional().default({}),
  explicit: memoryExplicitConfigSchema.optional().default({}),
});

const skillsSettingsSchema = z.object({
  baseDir: z.string().default('./skills'),
  autoInject: z.boolean().default(true),
  injectOnMention: z.boolean().default(true),
  maxInjectedSkills: z.number().int().positive().default(3),
  maxDescriptionLength: z.number().int().positive().default(500),
});

const historySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  maxLines: z.number().int().positive().default(100),
  filePath: z.string().default('~/.my-agent/history.txt'),
});

const sessionSettingsSchema = z.object({
  dir: z.string().default('~/.my-agent/sessions'), // Deprecated — now derived from AgentPaths
});

const tuiSettingsSchema = z.object({
  history: historySettingsSchema,
  sessions: sessionSettingsSchema,
});

const subAgentSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  autoTriggerThreshold: z.number().int().positive().default(5),
  isolation: z.boolean().default(true),
  worktreeRootDir: z.string().default('~/.my-agent/worktrees'), // Deprecated — now derived from AgentPaths
});

const securitySettingsSchema = z.object({
  allowedRoots: z.array(z.string()).default(['.']),
});

const mcpServerConfigSchema = z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'sse', 'streamable-http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  autoStart: z.boolean().optional(),
});

const mcpSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  servers: z.array(mcpServerConfigSchema).default([]),
  toolTimeoutMs: z.number().int().positive().default(30000),
  reconnectAttempts: z.number().int().positive().default(3),
  reconnectDelayMs: z.number().int().positive().default(1000),
});

const debugSettingsSchema = z.object({
  enabled: z.boolean().default(false),
});

const logSettingsSchema = z.object({
  dir: z.string().optional(),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional().default('info'),
});

const traceRedactionSettingsSchema = z.object({
  mode: z.enum(['default', 'none']).default('default'),
});

const traceNudgeSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  reviewInterval: z.number().int().positive().default(10),
});

const traceReviewSettingsSchema = z.object({
  enabled: z.boolean(),
  model: z.string(),
  maxTurns: z.number().min(3).max(12),
  tokenLimit: z.number().min(10_000).max(100_000),
  timeoutMs: z.number().min(30_000).max(300_000),
  outputDir: z.string(), // Deprecated — now derived from AgentPaths
  autoAcceptHours: z.number().positive().default(48),
  lowScoreWarningThreshold: z.number().min(0).max(1).default(0.5),
});

const traceSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  maxRunsPerSession: z.number().int().positive().default(50),
  redaction: traceRedactionSettingsSchema,
  nudge: traceNudgeSettingsSchema,
  review: traceReviewSettingsSchema,
});

const tavilySettingsSchema = z.object({
  apiKey: z.string().nullable().default(null),
});

const toolsSettingsSchema = z.object({
  tavily: tavilySettingsSchema,
});

const autoRetireConfigSchema = z.object({
  enabled: z.boolean().default(true),
  minSampleSize: z.number().int().positive().default(10),
  windowSize: z.number().int().positive().default(50),
  retireThreshold: z.number().min(0).max(1).default(0.2),
});

const evolutionSettingsSchema = z.object({
  autoRetire: autoRetireConfigSchema.optional().default({}),
});

const jobSpawnerConfigSchema = z.object({
  mode: z.enum(['spawn', 'inproc']).default('spawn'),
  invokeTimeoutMs: z.number().int().positive().default(60_000),
  lifetimeMs: z.number().int().positive().default(300_000),
  maxConcurrent: z.number().int().positive().default(2),
});

const jobsSettingsSchema = z.object({
  spawner: jobSpawnerConfigSchema.optional().default({}),
});

export const settingsSchema = z.object({
  version: z.number().optional().default(1),
  llm: llmSettingsSchema,
  context: contextSettingsSchema,
  memory: memorySettingsSchema,
  skills: skillsSettingsSchema,
  tui: tuiSettingsSchema,
  subAgent: subAgentSettingsSchema,
  /**
   * SECURITY: Allow direct sub-agent invocation via controlplane RPC,
   * bypassing the LLM tool-call gate. Intended for debugging only.
   * MUST remain false in production. Cannot be modified at runtime.
   */
  allowSubAgentDirectInvoke: z.boolean().default(false),
  security: securitySettingsSchema,
  tools: toolsSettingsSchema,
  debug: debugSettingsSchema,
  log: logSettingsSchema,
  mcp: mcpSettingsSchema,
  trace: traceSettingsSchema,
  evolution: evolutionSettingsSchema.optional().default({}),
  jobs: jobsSettingsSchema.optional().default({}),
});

