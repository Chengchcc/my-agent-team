/* eslint-disable max-lines-per-function */
import { nanoid } from 'nanoid';
import type { AgentContext, AgentConfig } from '../types';
import type { ToolCall } from '../types';
import type { AgentEvent, AgentLoopConfig, BudgetDelegationEvent, BudgetCompactEvent } from './loop-types';
import type { ContextManager } from './context';
import type { ToolDispatcher } from './tool-dispatch/dispatcher';
import type { ToolContext } from './tool-dispatch/types';
import { checkBatchBudget, checkToolBudget } from './budget-guard';
import { planExecution } from './dispatch';
import { debugLog } from '../utils/debug';
import { NANOID_LENGTH } from './loop-utils';

export interface RunToolsEnv {
  contextManager: ContextManager;
  config: AgentConfig;
  dispatcher: ToolDispatcher;
  buildToolContext: (resultContext: AgentContext, signal: AbortSignal) => ToolContext;
}

export async function* runTools(
  env: RunToolsEnv,
  toolCalls: ToolCall[],
  resultContext: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal,
  turnIndex: number,
): AsyncGenerator<AgentEvent> {
  debugLog(`[agent] runTools ENTRY: ${toolCalls.length} tools, turn=${turnIndex} t=${performance.now().toFixed(0)}`);
  const remaining = env.contextManager.getRemainingBudget();
  const totalLimit = env.config.tokenLimit;

  debugLog(`[agent] runTools budget-check START: t=${performance.now().toFixed(0)}`);
  const batchCheck = checkBatchBudget(toolCalls, remaining, totalLimit);
  debugLog(`[agent] runTools batch-check DONE: action=${batchCheck.action} t=${performance.now().toFixed(0)}`);
  if (batchCheck.action === 'delegate-to-sub-agent') {
    yield {
      type: 'budget_delegation',
      reason: batchCheck.reason!,
      originalTools: toolCalls.map(tc => tc.name),
      turnIndex,
    } satisfies BudgetDelegationEvent

    const subId = `budget-sub-${nanoid(NANOID_LENGTH)}`;
    const subAgentCall: ToolCall = {
      id: subId,
      name: 'sub_agent',
      arguments: { task: batchCheck.delegatedTask! },
    };
    toolCalls.length = 0;
    toolCalls.push(subAgentCall);
    env.contextManager.replaceLastAssistantToolCalls(toolCalls);
  } else if (batchCheck.action === 'compact-first') {
    yield {
      type: 'budget_compact',
      reason: batchCheck.reason!,
      turnIndex,
    } satisfies BudgetCompactEvent

    const currentContext = env.contextManager.getContext(env.config);
    const compressed = await env.contextManager.compressIfNeeded(currentContext);
    env.contextManager.setMessages(compressed.messages);
  } else {
    for (const [index, toolCall] of toolCalls.entries()) {
      debugLog(`[agent] runTools single-check START: ${toolCall.name} t=${performance.now().toFixed(0)}`);
      const remainingAfterPrevious = env.contextManager.getRemainingBudget();
      const singleCheck = checkToolBudget(toolCall, remainingAfterPrevious, totalLimit);
      debugLog(`[agent] runTools single-check DONE: ${toolCall.name} action=${singleCheck.action} t=${performance.now().toFixed(0)}`);
      if (singleCheck.action === 'delegate-to-sub-agent') {
        yield {
          type: 'budget_delegation',
          reason: singleCheck.reason!,
          originalTools: [toolCall.name],
          turnIndex,
        } satisfies BudgetDelegationEvent

        const subId = `budget-sub-${nanoid(NANOID_LENGTH)}`;
        toolCalls[index] = {
          id: subId,
          name: 'sub_agent',
          arguments: { task: singleCheck.delegatedTask! },
        };
        env.contextManager.replaceLastAssistantToolCalls(toolCalls);
      } else if (singleCheck.action === 'compact-first') {
        yield {
          type: 'budget_compact',
          reason: singleCheck.reason!,
          turnIndex,
        } satisfies BudgetCompactEvent

        const currentContext = env.contextManager.getContext(env.config);
        const compressed = await env.contextManager.compressIfNeeded(currentContext);
        env.contextManager.setMessages(compressed.messages);
      }
    }
  }

  const toolCtx = env.buildToolContext(resultContext, signal);
  const dispatchOptions = {
    parallel: config.parallelToolExecution,
    yieldAsCompleted: config.yieldEventsAsToolsComplete,
    toolTimeoutMs: config.toolTimeoutMs,
    maxOutputChars: config.maxToolOutputChars,
  };

  const plan = planExecution(
    toolCalls,
    (name) => env.dispatcher.toolRegistry.get(name),
  );
  const executed = new Set<string>();
  let eventCount = 0;

  debugLog(`[agent] runTools: plan has ${plan.waves.length} waves, turn=${turnIndex}`);

  for (const wave of plan.waves) {
    if (signal.aborted) break;

    const isParallelWave = config.parallelToolExecution && wave.length > 1;
    const waveOptions = {
      ...dispatchOptions,
      parallel: isParallelWave,
      yieldAsCompleted: isParallelWave || dispatchOptions.yieldAsCompleted,
    };

    for await (const event of env.dispatcher.dispatch(wave, toolCtx, waveOptions)) {
      eventCount++;
      switch (event.type) {
        case 'tool:start':
          yield {
            type: 'tool_call_start',
            toolCall: event.toolCall,
            turnIndex,
          } satisfies AgentEvent;
          break;

        case 'tool:result': {
          executed.add(event.toolCall.id);
          const rawContent = event.result.content;
          const content = typeof rawContent === 'string'
            ? rawContent
            : JSON.stringify(rawContent);

          if (event.result.isError && config.toolErrorStrategy === 'halt') {
            throw new Error(content);
          }

          env.contextManager.addMessage({
            role: 'tool',
            content,
            tool_call_id: event.toolCall.id,
            name: event.toolCall.name,
          });

          if (event.result.todoUpdates) {
            const currentTodoState = env.contextManager.getTodoState();
            env.contextManager.setTodoState({
              ...currentTodoState,
              todos: event.result.todoUpdates,
            });
          }

          yield {
            type: 'tool_call_result',
            toolCall: event.toolCall,
            result: content,
            durationMs: event.result.durationMs,
            isError: event.result.isError,
            ...(event.result.isError ? { error: new Error(content) } : {}),
            turnIndex,
          } satisfies AgentEvent;
        }
      }
    }
  }

  if (signal.aborted) {
    for (const tc of toolCalls) {
      if (!executed.has(tc.id)) {
        const content = 'Tool execution aborted';
        env.contextManager.addMessage({
          role: 'tool',
          content,
          tool_call_id: tc.id,
          name: tc.name,
        });
        yield {
          type: 'tool_call_result',
          toolCall: tc,
          result: content,
          durationMs: 0,
          isError: true,
          error: new Error(content),
          turnIndex,
        } satisfies AgentEvent;
      }
    }
  }

  debugLog(`[agent] runTools dispatch loop done: ${eventCount} events, ${plan.waves.length} waves`);
}
