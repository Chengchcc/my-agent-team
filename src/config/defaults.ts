import type { Settings } from './types';
import {
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  DEFAULT_SUMMARY_MODEL,
  DEFAULT_MAX_SUMMARY_TOKENS,
  DEFAULT_TOKEN_LIMIT,
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  DEFAULT_MCP_RECONNECT_ATTEMPTS,
  DEFAULT_MCP_RECONNECT_DELAY_MS,
} from './constants';

export const defaultSettings: Settings = {
  llm: {
    provider: 'claude',
    model: DEFAULT_MODEL,
    maxTokens: DEFAULT_MAX_TOKENS,
    temperature: DEFAULT_TEMPERATURE,
    apiKey: null,
    baseURL: null,
  },
  context: {
    tokenLimit: DEFAULT_TOKEN_LIMIT,
    budgetGuard: {
      enabled: true,
      delegateThreshold: 0.30,
      compactThreshold: 0.15,
      batchOutputRatio: 0.60,
      minReadCallsForBatch: 3,
    },
    compaction: {
      enabled: true,
      snipRatio: 0.60,
      autoCompactRatio: 0.75,
      collapseRatio: 0.90,
      toolOutputSnipThreshold: 8000,
      preserveRecentTurns: 4,
      summaryModel: DEFAULT_SUMMARY_MODEL,
      maxSummaryTokens: DEFAULT_MAX_SUMMARY_TOKENS,
      enabledTiers: {
        snip: true,
        autoCompact: true,
        reactiveRecovery: true,
        collapse: true,
      },
    },
  },
  memory: {
    enabled: true,
    globalBaseDir: '~/.my-agent/memory', // Deprecated — now derived from AgentPaths
    maxGeneralEntries: 500,
    consolidationThreshold: 50,
    autoExtractMinToolCalls: 3,
    maxInjectedEntries: 10,
    extractionModel: 'claude-3-haiku-20240307',
    retrievalThreshold: 0.75,
    retrievalTopK: 5,
    extractTriggerMode: 'explicit',
    maxUserPreferences: 20,
    preferenceWeightThreshold: 0.9,
    lifecycle: {
      semanticDedupThreshold: 0.12,
      contradictionTopK: 3,
      enableContradictionMerge: true,
      decayHalfLifeDays: 30,
      pruneAfterDays: 180,
      pruneMinUsageCount: 0,
    },
  },
  skills: {
    baseDir: './skills',
    autoInject: true,
    injectOnMention: true,
    maxInjectedSkills: 3,
    maxDescriptionLength: 500,
  },
  tui: {
    history: {
      enabled: true,
      maxLines: 100,
      filePath: '~/.my-agent/history.txt',
    },
    sessions: {
      dir: '~/.my-agent/sessions', // Deprecated — now derived from AgentPaths
    },
  },
  subAgent: {
    enabled: true,
    autoTriggerThreshold: 5,
    isolation: true,
    worktreeRootDir: '~/.my-agent/worktrees', // Deprecated — now derived from AgentPaths
  },
  security: {
    allowedRoots: ['.'],
  },
  tools: {
    tavily: {
      apiKey: null,
    },
  },
  debug: {
    enabled: false,
  },
  log: {
    level: 'info' as const,
  },
  mcp: {
    enabled: true,
    servers: [],
    toolTimeoutMs: DEFAULT_MCP_TOOL_TIMEOUT_MS,
    reconnectAttempts: DEFAULT_MCP_RECONNECT_ATTEMPTS,
    reconnectDelayMs: DEFAULT_MCP_RECONNECT_DELAY_MS,
  },
  trace: {
    enabled: true,
    maxRunsPerSession: 50,
    redaction: {
      mode: 'default' as const,
    },
    nudge: {
      enabled: true,
      reviewInterval: 10,
    },
    review: {
      enabled: true,
      model: 'claude-3-haiku-20240307',
      maxTurns: 6,
      tokenLimit: 30_000,
      timeoutMs: 60_000,
      outputDir: '~/.my-agent/skills/auto', // Deprecated — now derived from AgentPaths
      autoAcceptHours: 48,
      lowScoreWarningThreshold: 0.5,
    },
  },
};
