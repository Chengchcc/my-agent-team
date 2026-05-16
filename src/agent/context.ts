import { nanoid } from 'nanoid';
import { countTokens } from '@anthropic-ai/tokenizer';
import type { AgentContext, AgentConfig, CompressionStrategy, Message, ToolCall } from '../types';
import type { TodoItem } from '../todos/types';
import type { CompactionResult } from './compaction/types';
import { TokenAccumulator } from './token-accumulator';
import { getSettingsSync } from '../config';
import { defaultSettings } from '../config/defaults';
import { TrimOldestStrategy, countTotalTokens } from './trim-strategy';
export { TrimOldestStrategy } from './trim-strategy';
// Interface for compression strategies that support detailed compaction results
interface CompressionStrategyWithResult extends CompressionStrategy {
  compressWithResult(context: AgentContext, tokenLimit: number): Promise<CompactionResult>;
}

// Type guard to check if a compression strategy supports compressWithResult
function isCompressionWithResult(strategy: CompressionStrategy): strategy is CompressionStrategyWithResult {
  return 'compressWithResult' in strategy && typeof (strategy as CompressionStrategyWithResult).compressWithResult === 'function';
}

export interface ContextManagerConfig {
  tokenLimit?: number;
  compressionStrategy?: CompressionStrategy;
  defaultSystemPrompt?: string;
  initialMetadata?: Record<string, unknown>;
}

/**
 * Manages conversation context with compression.
 */
export class ContextManager {
  private messages: Message[];
  private tokenLimit: number;
  private compressionStrategy: CompressionStrategy;
  private defaultSystemPrompt?: string;
  private currentSystemPrompt?: string;
  private todoStore: TodoItem[] = [];
  private todoStepsSinceLastWrite = Infinity;
  private todoStepsSinceLastReminder = Infinity;
  private lastKnownPromptTokens: number = 0;
  private accumulatedOutputTokens: number = 0;
  private accumulator = new TokenAccumulator();
  private initialMetadata: Record<string, unknown>;

  constructor(config: ContextManagerConfig = {}) {
    this.initialMetadata = config.initialMetadata ?? {};
    let tokenLimit;
    try {
      const settings = getSettingsSync();
      tokenLimit = config.tokenLimit ?? settings.context.tokenLimit;
    } catch {
      tokenLimit = config.tokenLimit ?? defaultSettings.context.tokenLimit;
    }
    this.tokenLimit = tokenLimit;
    this.compressionStrategy = config.compressionStrategy ?? new TrimOldestStrategy();
    this.messages = [];
    if (config.defaultSystemPrompt) {
      this.defaultSystemPrompt = config.defaultSystemPrompt;
      this.currentSystemPrompt = config.defaultSystemPrompt;
      this.accumulator.setSystemPrompt(countTokens(config.defaultSystemPrompt));
    }

    if (this.defaultSystemPrompt) {
      const sysMsg: Message = {
        role: 'system',
        content: this.defaultSystemPrompt,
        id: nanoid(),
      };
      this.messages.push(sysMsg);
      this.accumulator.add(sysMsg);
    }
  }

  /**
   * Add a message to the context.
   * Automatically assigns a unique id if not provided.
   * Incrementally updates the token cache instead of invalidating.
   */
  private static readonly MAX_MESSAGES = 2000;

  addMessage(message: Message): void {
    const msg = { ...message, id: message.id ?? nanoid() };

    // G-10: guard against duplicate tool_use_ids across messages
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const seenIds = new Set(this.messages
        .filter(m => m.role === 'assistant' && m.tool_calls)
        .flatMap(m => m.tool_calls!.map(tc => tc.id)));
      msg.tool_calls = msg.tool_calls.filter(tc => !seenIds.has(tc.id));
      if (msg.tool_calls.length === 0) return;
    }

    this.messages.push(msg);
    this.accumulator.add(msg);

    // G-12: token-based trimming before message-count cap
    const TRIM_SOFT_CAP_RATIO = 0.95;
    const softCap = this.tokenLimit * TRIM_SOFT_CAP_RATIO;
    if (this.accumulator.total > softCap && this.messages.length > 2) {
      const nonSys = this.messages.filter(m => m.role !== 'system');
      while (this.accumulator.total > softCap && nonSys.length) {
        const r = nonSys.shift();
        if (r?.id) this.accumulator.remove(r.id);
      }
      this.messages = [...this.messages.filter(m => m.role === 'system'), ...nonSys];
    }

    // Trim oldest non-system messages when over the count cap
    if (this.messages.length > ContextManager.MAX_MESSAGES) {
      const sys = this.messages.filter(m => m.role === 'system');
      const rest = this.messages.filter(m => m.role !== 'system');
      this.messages = [...sys, ...rest.slice(sys.length - ContextManager.MAX_MESSAGES)];
    }
  }

  /**
   * Get current messages.
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * Update the current system prompt (for dynamic skill injection).
   */
  setSystemPrompt(systemPrompt: string): void {
    this.currentSystemPrompt = systemPrompt;
    this.accumulator.setSystemPrompt(countTokens(systemPrompt));
    this.lastKnownPromptTokens = 0; // G-9: invalidate cached token count
  }

  /**
   * Get the current system prompt.
   */
  getSystemPrompt(): string | undefined {
    return this.currentSystemPrompt;
  }

  /**
   * Set a metadata key-value pair that will be included in getContext().
   */
  setMetadata(key: string, value: unknown): void {
    this.initialMetadata[key] = value;
  }

  /**
   * Get AgentContext for passing through pipeline.
   */
  getContext(config: AgentConfig): AgentContext {
    const result: AgentContext = {
      messages: [...this.messages],
      config,
      metadata: {
        // Embed current todo state into metadata for tools and middleware
        ...this.initialMetadata,
        todo: {
          todoStore: [...this.todoStore],
          stepsSinceLastWrite: this.todoStepsSinceLastWrite,
          stepsSinceLastReminder: this.todoStepsSinceLastReminder,
        },
      },
    };
    if (this.currentSystemPrompt) {
      result.systemPrompt = this.currentSystemPrompt;
    }
    return result;
  }

  /**
   * Update todo state from metadata after processing.
   * This needs to be called after the middleware/tool execution to persist changes.
   */
  syncTodoFromContext(context: AgentContext): void {
    const todo = context.metadata?.todo as { todoStore: TodoItem[]; stepsSinceLastWrite: number; stepsSinceLastReminder: number } | undefined;
    if (todo) {
      this.todoStore = [...todo.todoStore];
      this.todoStepsSinceLastWrite = todo.stepsSinceLastWrite;
      this.todoStepsSinceLastReminder = todo.stepsSinceLastReminder;
    }
  }

  /**
   * Get current todos.
   */
  getTodos(): TodoItem[] {
    return [...this.todoStore];
  }

  /**
   * Helper to get compaction result with shared fallback logic.
   */
  private async getCompactionResult(
    context: AgentContext,
    tokenLimit: number,
    currentTokens: number,
  ): Promise<CompactionResult> {
    // Always let the compression strategy decide - it has its own internal thresholds
    // This avoids duplicate checks that prevent tiered compaction from triggering at the right time
    if (this.compressionStrategy) {
      if (isCompressionWithResult(this.compressionStrategy)) {
        return this.compressionStrategy.compressWithResult(context, tokenLimit);
      }
      const compressed = await this.compressionStrategy.compress(context, tokenLimit);
      return {
        messages: compressed,
        level: 'none' as const,
        compacted: compressed.length < context.messages.length,
        tokensBefore: currentTokens,
        tokensAfter: countTotalTokens(compressed, context.systemPrompt),
      };
    }
    return {
      messages: context.messages,
      level: 'none' as const,
      compacted: false,
      tokensBefore: currentTokens,
      tokensAfter: currentTokens,
    };
  }

  /**
   * Compress messages if over token limit.
   */
  async compressIfNeeded(context: AgentContext): Promise<CompactionResult> {
    const tokenLimit = context.config.tokenLimit;
    const currentTokens = this.getLastKnownPromptTokens();

    return this.getCompactionResult(context, tokenLimit, currentTokens);
  }

  /**
   * Clear all messages (keeps default system prompt if exists).
   */
  clear(): void {
    this.accumulator.clear();
    this.messages = [];
    this.todoStore = [];
    this.todoStepsSinceLastWrite = Infinity;
    this.todoStepsSinceLastReminder = Infinity;
    this.lastKnownPromptTokens = 0;
    // Reset compaction cascade state so stale history doesn't carry over
    this.compressionStrategy?.resetCompactionState?.();
    if (this.defaultSystemPrompt) {
      this.currentSystemPrompt = this.defaultSystemPrompt;
      this.accumulator.setSystemPrompt(countTokens(this.defaultSystemPrompt));
      const sysMsg: Message = {
        role: 'system',
        content: this.defaultSystemPrompt,
        id: nanoid(),
      };
      this.messages.push(sysMsg);
      this.accumulator.add(sysMsg);
    }
  }

  /**
   * Get the token limit.
   */
  getTokenLimit(): number {
    return this.tokenLimit;
  }

  /**
   * Get accumulated output tokens from all model responses.
   */
  getAccumulatedOutputTokens(): number {
    return this.accumulatedOutputTokens;
  }

  /**
   * Get the current todo tracking state for TUI display.
   */
  getTodoState(): { todos: TodoItem[]; stepsSinceLastWrite: number; stepsSinceLastReminder: number } {
    return {
      todos: [...this.todoStore],
      stepsSinceLastWrite: this.todoStepsSinceLastWrite,
      stepsSinceLastReminder: this.todoStepsSinceLastReminder,
    };
  }

  /**
   * Update the todo tracking state after tool execution.
   */
  setTodoState(state: { todos: TodoItem[]; stepsSinceLastWrite: number; stepsSinceLastReminder: number }): void {
    this.todoStore = [...state.todos];
    this.todoStepsSinceLastWrite = state.stepsSinceLastWrite;
    this.todoStepsSinceLastReminder = state.stepsSinceLastReminder;
  }

  /**
   * Replace all messages (used after compression).
   */
  setMessages(messages: Message[]): void {
    // Keep system messages separate to maintain the default system prompt
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    this.messages = [...systemMessages, ...nonSystemMessages];
    this.accumulator.setMessages(this.messages);
    // Invalidate API-reported token count so getRemainingBudget / getUsageRatio
    // re-compute from the accumulator until the next API response updates it.
    this.lastKnownPromptTokens = 0;
  }

  /**
   * Update token counting with accurate usage data from API response.
   */
  updateTokenUsage(usage: { prompt_tokens: number; completion_tokens: number }): void {
    this.lastKnownPromptTokens = usage.prompt_tokens;
    this.accumulatedOutputTokens += usage.completion_tokens;
  }

  /**
   * Get current context usage ratio (0-1).
   */
  /**
   * Get current estimated context tokens (O(1) — reads from accumulator).
   * Used by TUI Footer and compaction threshold checks.
   */
  getCurrentTokens(): number {
    return this.accumulator.total;
  }

  getUsageRatio(): number {
    if (this.lastKnownPromptTokens <= 0) {
      return this.getCurrentTokens() / this.tokenLimit;
    }
    return this.lastKnownPromptTokens / this.tokenLimit;
  }

  /**
   * Get remaining token budget for new content.
   */
  getRemainingBudget(): number {
    if (this.lastKnownPromptTokens <= 0) {
      return this.tokenLimit - this.getCurrentTokens();
    }
    return this.tokenLimit - this.lastKnownPromptTokens;
  }

  // Exposed for diagnostics
  get _lastKnownPromptTokens() { return this.lastKnownPromptTokens; }

  /**
   * Get the last known prompt tokens from API.
   */
  getLastKnownPromptTokens(): number {
    if (this.lastKnownPromptTokens <= 0) {
      return this.getCurrentTokens();
    }
    return this.lastKnownPromptTokens;
  }

  /**
   * Force compaction with optional focus hint.
   */
  async forceCompact(focusHint?: string): Promise<CompactionResult> {
    const agentConfig: AgentConfig = {
      tokenLimit: this.tokenLimit,
    };
    if (this.defaultSystemPrompt) {
      agentConfig.defaultSystemPrompt = this.defaultSystemPrompt;
    }
    const context = this.getContext(agentConfig);
    if (focusHint && context.systemPrompt) {
      context.systemPrompt = `${context.systemPrompt}\n\nFocus hint: ${focusHint}`;
    }
    const totalTokens = this.getLastKnownPromptTokens();

    return this.getCompactionResult(context, this.tokenLimit, totalTokens);
  }

  /**
   * Replace tool_calls in the last assistant message.
   * Used when budget guard replaces tool calls with sub-agent delegation.
   */
  replaceLastAssistantToolCalls(toolCalls: ToolCall[]): void {
    const messages = [...this.messages];
    // Find the last assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.role === 'assistant') {
        const oldId = msg.id;
        const newId = nanoid();
        messages[i] = {
          ...msg,
          id: newId,
          tool_calls: toolCalls,
        };
        // Reconcile accumulator BEFORE assigning to this.messages.
        // If accumulator operations throw, this.messages stays consistent.
        if (oldId) this.accumulator.remove(oldId);
        this.accumulator.add(messages[i]!);
        this.messages = messages;
        return;
      }
    }
  }
}
