/* eslint-disable max-lines-per-function, complexity */
import type {
  AgentContext,
  AgentConfig,
  Provider,
  ToolCall,
  AgentHooks,
  ContentBlock,
  Message,
} from '../types';
import type { AgentEvent, ContextCompactedEvent } from './loop-types';
import type { ContextManager } from './context';
import { composeMiddlewares } from './middleware';
import {
  MAX_STREAM_RETRIES,
  classifyStreamError, retryDelay, sleep, truncateEphemeralReminders, COMPACTION_TIER_FULL,
} from './loop-utils';

export interface SingleTurnEnv {
  provider: Provider;
  contextManager: ContextManager;
  hooks: Required<AgentHooks>;
  config: AgentConfig;
}

export async function* runSingleTurn(
  env: SingleTurnEnv,
  turnIndex: number,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent, {
  toolCalls: ToolCall[];
  resultContext: AgentContext;
  done: boolean;
}> {
  const currentContext = env.contextManager.getContext(env.config);
  const composedBeforeCompress = composeMiddlewares(
    env.hooks.beforeCompress,
    (ctx) => Promise.resolve(ctx),
  );

  let afterBeforeCompress: AgentContext;
  try {
    afterBeforeCompress = await composedBeforeCompress(currentContext);
  } catch (hookError) {
    console.warn('[agent] beforeCompress hook failed:', hookError);
    afterBeforeCompress = currentContext;
  }
  env.contextManager.syncTodoFromContext(afterBeforeCompress);

  const compactionResult = await env.contextManager.compressIfNeeded(afterBeforeCompress);
  afterBeforeCompress.messages = compactionResult.messages;
  env.contextManager.setMessages(compactionResult.messages);

  if (compactionResult.tier === COMPACTION_TIER_FULL) {
    afterBeforeCompress.metadata.justCollapsed = true;
  }

  if (compactionResult.compacted) {
    yield {
      type: 'context_compacted',
      level: compactionResult.level,
      beforeTokens: compactionResult.tokensBefore,
      afterTokens: compactionResult.tokensAfter,
      turnIndex,
    } satisfies ContextCompactedEvent;
  }

  const composedBeforeModel = composeMiddlewares(
    env.hooks.beforeModel,
    (innerCtx) => Promise.resolve(innerCtx),
  );
  let resultContext: AgentContext;
  try {
    resultContext = await composedBeforeModel(afterBeforeCompress);
  } catch (hookError) {
    console.warn('[agent] beforeModel hook failed:', hookError);
    resultContext = afterBeforeCompress;
  }
  env.contextManager.syncTodoFromContext(resultContext);

  if (resultContext.ephemeralReminders?.length) {
    const reminders = truncateEphemeralReminders(resultContext.ephemeralReminders);
    const reminderBlock = reminders.join('\n\n');
    const messages = resultContext.messages;
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx >= 0) {
      messages.splice(lastUserIdx, 0, {
        role: 'user',
        content: reminderBlock,
        _ephemeral: true,
      });
    } else {
      messages.push({
        role: 'user',
        content: reminderBlock,
        _ephemeral: true,
      });
    }
    resultContext.ephemeralReminders = [];
  }

  let fullContent = '';
  let thinkingBuffer = '';
  let thinkingSignature: string | undefined;
  const toolCalls: ToolCall[] = [];
  let usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | undefined;
  let streamError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_STREAM_RETRIES; attempt++) {
    if (signal.aborted) break;

    if (attempt > 1) {
      fullContent = '';
      thinkingBuffer = '';
      thinkingSignature = undefined;
      toolCalls.length = 0;
      usage = undefined;
    }

    try {
      for await (const chunk of env.provider.stream(resultContext, { signal })) {
        if (signal.aborted) break;
        if (chunk.thinking) {
          thinkingBuffer += chunk.thinking;
          yield {
            type: 'thinking_delta',
            delta: chunk.thinking,
            turnIndex,
          } satisfies AgentEvent;
        }
        if (chunk.thinkingSignature) {
          thinkingSignature = chunk.thinkingSignature;
          yield {
            type: 'thinking_done',
            signature: chunk.thinkingSignature,
            turnIndex,
          } satisfies AgentEvent;
        }
        if (chunk.content) {
          fullContent += chunk.content;
          yield {
            type: 'text_delta',
            delta: chunk.content,
            turnIndex,
          } satisfies AgentEvent;
        }
        if (chunk.tool_calls) {
          for (const tc of chunk.tool_calls) {
            if (!toolCalls.some(existing => existing.id === tc.id)) {
              toolCalls.push(tc);
            }
          }
        }
        if (chunk.usage) {
          usage = chunk.usage;
          if (usage && env.contextManager) {
            env.contextManager.updateTokenUsage(usage);
          }
        }
      }

      streamError = null;
      break;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const kind = classifyStreamError(error);

      if (kind === 'fatal') {
        streamError = error;
        break;
      }

      if (attempt < MAX_STREAM_RETRIES) {
        yield {
          type: 'text_delta',
          delta: `\n\n[Stream interrupted: ${error.message}. Retrying...]`,
          turnIndex,
        } satisfies AgentEvent;
        await sleep(retryDelay(attempt));
      } else {
        streamError = error;
      }
    }
  }

  if (signal.aborted) {
    yield {
      type: 'agent_error',
      error: new Error('Agent execution aborted'),
      turnIndex,
    } satisfies AgentEvent;
    return { toolCalls: [], resultContext, done: true };
  }

  if (streamError) {
    const hasPartial = fullContent.length > 0 || thinkingBuffer.length > 0 || toolCalls.length > 0;
    if (hasPartial) {
      const blocks: ContentBlock[] = [];
      if (thinkingBuffer.length > 0) {
        blocks.push({ type: 'thinking', thinking: thinkingBuffer, signature: thinkingSignature ?? '' });
      }
      if (fullContent.length > 0) {
        blocks.push({ type: 'text', text: fullContent });
      }
      const assistantMsg: Message = {
        role: 'assistant',
        content: fullContent || '(interrupted)',
        ...(blocks.length > 0 ? { blocks } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, arguments: tc.arguments })) } : {}),
      };
      env.contextManager.addMessage(assistantMsg);
      yield {
        type: 'text_delta',
        delta: `\n\n[Stream interrupted after ${MAX_STREAM_RETRIES} retries. Partial response saved.]`,
        turnIndex,
      } satisfies AgentEvent;
      yield {
        type: 'agent_error',
        error: streamError,
        turnIndex,
      } satisfies AgentEvent;
      return { toolCalls: [], resultContext, done: true };
    }
    throw streamError;
  }

  const composedAfterModel = composeMiddlewares(
    env.hooks.afterModel,
    (ctx) => Promise.resolve(ctx),
  );
  try {
    resultContext = await composedAfterModel(resultContext);
  } catch (hookError) {
    console.warn('[agent] afterModel hook failed:', hookError);
  }
  env.contextManager.syncTodoFromContext(resultContext);

  resultContext.response = {
    content: fullContent,
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    model: env.provider.getModelName(),
  };
  if (toolCalls.length > 0) {
    resultContext.response.tool_calls = toolCalls;
  }

  const composedBeforeAddResponse = composeMiddlewares(
    env.hooks.beforeAddResponse,
    (ctx) => Promise.resolve(ctx),
  );
  resultContext = await composedBeforeAddResponse(resultContext);
  env.contextManager.syncTodoFromContext(resultContext);

  if (resultContext.response) {
    const blocks: ContentBlock[] = [];
    if (thinkingBuffer) {
      blocks.push({
        type: 'thinking',
        thinking: thinkingBuffer,
        ...(thinkingSignature ? { signature: thinkingSignature } : {}),
      });
    }
    if (fullContent) {
      blocks.push({ type: 'text', text: fullContent });
    }
    for (const tc of toolCalls) {
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: tc.arguments,
      });
    }

    if (blocks.length > 0) resultContext.response.blocks = blocks;

    const msg: { role: 'assistant'; content: string; blocks?: typeof blocks; tool_calls?: ToolCall[] } = {
      role: 'assistant',
      content: resultContext.response.content,
      ...(blocks.length > 0 ? { blocks } : {}),
    };
    if (resultContext.response.tool_calls && resultContext.response.tool_calls.length > 0) {
      msg.tool_calls = resultContext.response.tool_calls;
    }
    env.contextManager.addMessage(msg);
  }

  const done = !toolCalls || toolCalls.length === 0;
  const turnCompleteEvent: { type: 'turn_complete'; turnIndex: number; hasToolCalls: boolean; usage?: typeof usage } = {
    type: 'turn_complete',
    turnIndex,
    hasToolCalls: !done,
  };
  if (usage) {
    turnCompleteEvent.usage = usage;
  }
  yield turnCompleteEvent as AgentEvent;

  return { toolCalls, resultContext, done };
}
