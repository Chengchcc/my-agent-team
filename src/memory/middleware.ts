import type { Middleware, AgentMiddleware } from '../types';
import type { Message } from '../types';
import type { MemoryStore, MemoryRetriever, MemoryConfig } from './types';
import { getSettingsSync } from '../config';
import { loadAgentMdCached } from './agent-md';
import { djb2Hash } from '../utils/hash';

// Fallback defaults if settings aren't loaded yet
const FALLBACK_MAX_GENERAL_ENTRIES = 500;
const FALLBACK_CONSOLIDATION_THRESHOLD = 50;
const FALLBACK_AUTO_EXTRACT_MIN_TOOL_CALLS = 3;
const FALLBACK_MAX_INJECTED_ENTRIES = 10;
const FALLBACK_RETRIEVAL_THRESHOLD = 0.75;
const FALLBACK_RETRIEVAL_TOP_K = 5;
const FALLBACK_MAX_USER_PREFERENCES = 20;

const POST_COLLAPSE_RETRIEVAL_MULTIPLIER = 2;
const RECENT_USER_TURN_COUNT = 3;

const FALLBACK_MEMORY_CONFIG: Required<MemoryConfig> = {
  globalBaseDir: '~/.my-agent/memory',
  maxGeneralEntries: FALLBACK_MAX_GENERAL_ENTRIES,
  consolidationThreshold: FALLBACK_CONSOLIDATION_THRESHOLD,
  autoExtractMinToolCalls: FALLBACK_AUTO_EXTRACT_MIN_TOOL_CALLS,
  maxInjectedEntries: FALLBACK_MAX_INJECTED_ENTRIES,
  extractionModel: 'claude-3-haiku-20240307',
  retrievalThreshold: FALLBACK_RETRIEVAL_THRESHOLD,
  retrievalTopK: FALLBACK_RETRIEVAL_TOP_K,
  extractTriggerMode: 'explicit',
  maxUserPreferences: FALLBACK_MAX_USER_PREFERENCES,
  preferenceWeightThreshold: 0.9,
};

// Get settings with fallback
function getMemoryConfig(): Required<MemoryConfig> {
  try {
    const settings = getSettingsSync();
    return settings.memory as unknown as Required<MemoryConfig>;
  } catch {
    return FALLBACK_MEMORY_CONFIG;
  }
}

export class MemoryMiddleware implements AgentMiddleware {
  private generalStore: MemoryStore;
  private retriever: MemoryRetriever;
  private config: Required<MemoryConfig>;
  private extractQueue: { enqueue: (task: any) => Promise<any> } | null = null;

  constructor(
    stores: {
      general: MemoryStore;
    },
    retriever: MemoryRetriever,
    config: MemoryConfig = {},
    extractQueue?: { enqueue: (task: any) => Promise<any> } | null,
  ) {
    this.generalStore = stores.general;
    this.retriever = retriever;
    this.config = { ...getMemoryConfig(), ...config };
    this.extractQueue = extractQueue ?? null;
  }

  beforeModel: Middleware = async (context, next) => {
    // Strip previous memory-managed sections from system prompt (they'll be re-added below).
    const stripMemorySections = (prompt: string): string =>
      prompt.replace(
        /\n\n<(?:project_rules|user_preferences)[^>]*>[\s\S]*?<\/(?:project_rules|user_preferences)>/g,
        '',
      ).trim();

    const base = stripMemorySections(context.systemPrompt || '');

    // Layer 1: AGENT.md — stable project rules with mtime-based version for cache-busting
    const { merged: agentMd, version: rulesVersion } = await loadAgentMdCached();

    // Layer 2: User preferences — entries with weight >= threshold, always present
    const allPrefs = await this.generalStore.getAll();
    const highWeightPrefs = allPrefs
      .filter(e => e.weight >= this.config.preferenceWeightThreshold)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, this.config.maxUserPreferences);
    const prefsText = highWeightPrefs.map(p => `- ${p.text}`).join('\n');
    const prefsVersion = djb2Hash(prefsText);

    // Build stable system-extra sections
    const sections: string[] = [];
    if (agentMd) {
      sections.push(`<project_rules version="${rulesVersion}">\n${agentMd}\n</project_rules>`);
    }
    if (prefsText) {
      sections.push(`<user_preferences version="${prefsVersion}">\n${prefsText}\n</user_preferences>`);
    }
    if (sections.length > 0) {
      context.systemPrompt = [base, ...sections].filter(Boolean).join('\n\n');
    }

    // Layer 3: General recall by query → ephemeral reminder
    const lastUserMessage = findLastUserMessage(context.messages);
    const isPostCollapse = !!context.metadata.justCollapsed;
    if (lastUserMessage) {
      const retrievalThreshold = isPostCollapse ? 0 : this.config.retrievalThreshold;
      const retrievalLimit = isPostCollapse ? this.config.retrievalTopK * POST_COLLAPSE_RETRIEVAL_MULTIPLIER : this.config.retrievalTopK;

      const hits = await this.retriever.search(lastUserMessage.content, {
        limit: retrievalLimit,
        threshold: retrievalThreshold,
      });

      if (isPostCollapse) {
        context.metadata.justCollapsed = false;
      }

      if (hits.length > 0) {
        const body = hits.map(h => {
          const date = h.created.split('T')[0];
          return `- (${date}) ${h.text}`;
        }).join('\n');
        context.ephemeralReminders ??= [];
        context.ephemeralReminders.push(
          `<system-reminder>\n<retrieved_memory>\n${body}\n</retrieved_memory>\n</system-reminder>`,
        );
        void this.generalStore.markHit?.(hits.map(h => h.id));
      }
    }

    return next();
  };

  afterAgentRun: Middleware = async (context, next) => {
    const result = await next();

    // Check trigger conditions for auto-extraction:
    // 1. Last response has no tool calls -> task completed
    // 2. Total tool calls >= threshold -> did meaningful work
    const lastResponse = findLastResponse(context.messages);
    if (!lastResponse || (lastResponse.tool_calls && lastResponse.tool_calls.length > 0)) {
      return result;
    }

    const toolCallCount = countToolCalls(context.messages);
    if (toolCallCount < this.config.autoExtractMinToolCalls) {
      return result;
    }

    // Trigger-word gate: in 'explicit' mode, only extract when user said trigger words
    if (this.config.extractTriggerMode === 'off') {
      return result;
    }
    if (this.config.extractTriggerMode === 'explicit' && !shouldExtractFromMessages(context.messages)) {
      return result;
    }

    const traceId = context.metadata.traceId as string | undefined;

    if (this.extractQueue && traceId) {
      void this.extractQueue.enqueue({
        kind: 'mem-extract' as any,
        traceId,
        projectPath: process.cwd(),
      }).catch(err => {
        console.error('[memory] Failed to enqueue mem-extract:', err);
      });
    }

    return result;
  };

}

// Helper functions
function findLastUserMessage(messages: Message[]): Message | undefined {
  return [...messages].reverse().find(m => m.role === 'user');
}

function findLastResponse(messages: Message[]): Message | undefined {
  return [...messages].reverse().find(m => m.role === 'assistant');
}

function countToolCalls(messages: Message[]): number {
  return messages.filter(m => m.role === 'tool').length;
}


// Trigger words for explicit extraction mode — only extract when user uses these
const WRITE_TRIGGERS = [
  /记住/, /remember/i, /from now on/i, /always/i, /never/i,
  /我喜欢/, /我习惯/, /I prefer/i, /I like/i,
  /别再/, /don't/i, /stop doing/i,
  /保存这个/, /save this/i, /记录下来/, /note this/i,
];

function shouldExtractFromMessages(messages: Message[]): boolean {
  const userTurns = messages.filter(m => m.role === 'user');
  const recent = userTurns.slice(-RECENT_USER_TURN_COUNT).map(m => m.content).join('\n');
  return WRITE_TRIGGERS.some(re => re.test(recent));
}
