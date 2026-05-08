import type {
  AgentContext,
  AgentConfig,
  Provider,
  ToolCall,
  AgentHooks,
} from '../types';
import type { AgentEvent, AgentLoopConfig } from './loop-types';
import type { ToolContext } from './tool-dispatch/types';
import type { ContextManager } from './context';
import { composeMiddlewares } from './middleware';
import { DEFAULT_LOOP_CONFIG } from './loop-types';
import type { ToolDispatcher } from './tool-dispatch/dispatcher';
import { createToolSink } from './tool-dispatch/types';
import { debugLog } from '../utils/debug';
import { runTools as runToolsImpl } from './run-tools';
import { runSingleTurn as runSingleTurnImpl } from './single-turn';

export class AgentLoop {
  private controller: AbortController | null = null;

  constructor(
    private provider: Provider,
    private contextManager: ContextManager,
    private hooks: Required<AgentHooks>,
    private config: AgentConfig,
    private dispatcher: ToolDispatcher,
  ) {}

  /** Abort the active run. Safe to call from any thread. */
  abort(): void {
    if (this.controller) {
      this.controller.abort();
    }
  }

  /**
   * Run the full autonomous agentic loop:
   * LLM → execute tool_calls → repeat until no more tool calls.
   * Yields events for each step for observable execution.
   */
  async *run(
    userMessage: { role: 'user'; content: string; id?: string },
    loopConfig?: Partial<AgentLoopConfig>,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<AgentEvent> {
    const config: AgentLoopConfig = { ...DEFAULT_LOOP_CONFIG, ...loopConfig };
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;

    // Chain from external signal if provided - propagate abort
    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    // Create timeout timer
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, config.timeoutMs);

    let turnIndex = 0;
    let done = false;
    let errorOccurred = false;
    let lastResultContext: AgentContext | undefined;

    try {
      // Phase 1: Setup
      await this.runSetup(userMessage);

      // Main loop: Phase 2 (LLM turn) -> Phase 3 (Tools)
      while (turnIndex <= config.maxTurns && !done && !signal.aborted) {
        // Phase 2: Single LLM turn
        const turnResult = yield* this.runSingleTurn(turnIndex, config, signal);
        done = turnResult.done;
        lastResultContext = turnResult.resultContext;

        if (signal.aborted) {
          errorOccurred = true;
          break;
        }

        if (!done && turnResult.toolCalls.length > 0) {
          debugLog(`[agent] main-loop calling runTools: ${turnResult.toolCalls.length} tools t=${performance.now().toFixed(0)}`);
          // Phase 3: Execute tools
          yield* this.runTools(
            turnResult.toolCalls,
            turnResult.resultContext,
            config,
            signal,
            turnIndex,
          );
          turnIndex++;
        }
      }

      // Phase 4: Teardown
      yield* this.runTeardown(lastResultContext, config, turnIndex, done, errorOccurred);
    } catch (error) {
      yield {
        type: 'agent_error',
        error: error instanceof Error ? error : new Error(String(error)),
        turnIndex,
      } satisfies AgentEvent;
      yield {
        type: 'agent_done',
        totalTurns: turnIndex + 1,
        reason: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
        turnIndex,
      } satisfies AgentEvent;
    } finally {
      clearTimeout(timeoutId);
      this.controller = null;
    }
  }

  // ===== Phase 1: Setup =====

  private async runSetup(
    userMessage: { role: 'user'; content: string; id?: string },
  ): Promise<void> {
    this.contextManager.addMessage({
      role: 'user',
      content: userMessage.content,
      ...(userMessage.id ? { id: userMessage.id } : {}),
    });

    const initialContext = this.contextManager.getContext(this.config);
    const composedBeforeAgentRun = composeMiddlewares(
      this.hooks.beforeAgentRun,
      (ctx) => Promise.resolve(ctx),
    );
    const afterBeforeAgentRun = await composedBeforeAgentRun(initialContext);

    if (afterBeforeAgentRun.systemPrompt) {
      this.contextManager.setSystemPrompt(afterBeforeAgentRun.systemPrompt);
    }
    this.contextManager.syncTodoFromContext(afterBeforeAgentRun);
  }

  // ===== Phase 2: Single LLM turn =====

   private async *runSingleTurn(
    turnIndex: number,
    _config: AgentLoopConfig,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, {
    toolCalls: ToolCall[];
    resultContext: AgentContext;
    done: boolean;
  }> {
    return yield* runSingleTurnImpl(
      { provider: this.provider, contextManager: this.contextManager, hooks: this.hooks, config: this.config },
      turnIndex,
      signal,
    );
  }

  // ===== Phase 3: Tool execution =====

  private async *runTools(
    toolCalls: ToolCall[],
    resultContext: AgentContext,
    config: AgentLoopConfig,
    signal: AbortSignal,
    turnIndex: number,
  ): AsyncGenerator<AgentEvent> {
    return yield* runToolsImpl(
      { contextManager: this.contextManager, config: this.config, dispatcher: this.dispatcher, buildToolContext: (rc, s) => this.buildToolContext(rc, s) },
      toolCalls, resultContext, config, signal, turnIndex,
    );
  }

  // ===== Phase 4: Teardown =====

  private async *runTeardown(
    lastResultContext: AgentContext | undefined,
    config: AgentLoopConfig,
    turnIndex: number,
    done: boolean,
    errorOccurred: boolean,
  ): AsyncGenerator<AgentEvent> {
    if (lastResultContext) {
      const todoState = this.contextManager.getTodoState();
      const finalContext = {
        ...lastResultContext,
        ...this.contextManager.getContext(this.config),
        metadata: {
          ...lastResultContext.metadata,
          todo: {
            ...(lastResultContext.metadata.todo || {}),
            todoStore: todoState.todos,
            stepsSinceLastWrite: todoState.stepsSinceLastWrite,
            stepsSinceLastReminder: todoState.stepsSinceLastReminder,
          },
        },
      };
      const composedAfterAgentRun = composeMiddlewares(
        this.hooks.afterAgentRun,
        (ctx) => Promise.resolve(ctx),
      );
      try {
        await composedAfterAgentRun(finalContext);
      } catch (hookError) {
        console.warn('[agent] afterAgentRun hook failed:', hookError);
      }
    }

    let reason: 'completed' | 'max_turns_reached' | 'error' = 'completed';
    if (errorOccurred) {
      reason = 'error';
    } else if (turnIndex >= config.maxTurns && !done) {
      reason = 'max_turns_reached';
    }

    const totalTurns = done ? turnIndex + 1 : turnIndex;
    yield {
      type: 'agent_done',
      totalTurns,
      reason,
      turnIndex,
    } satisfies AgentEvent;
  }

  // ===== Helpers =====

  private buildToolContext(agentCtx: AgentContext, signal: AbortSignal): ToolContext {
    return {
      signal,
      agentContext: Object.freeze({ ...agentCtx }),
      budget: {
        remaining: this.contextManager.getRemainingBudget(),
        usageRatio: this.contextManager.getUsageRatio(),
      },
      environment: {
        agentType: 'main' as const,
        cwd: process.cwd(),
      },
      metadata: new Map(),
      sink: createToolSink(),
    };
  }
}
