import { useCallback, useRef } from 'react';
import { nanoid } from 'nanoid';
import type { UIAction } from '../state/types';
import type { Agent } from '../../../agent';
import type { AgentEvent } from '../../../agent/loop-types';

type AgentLoopDispatch = (a: UIAction) => void;
type FlushFn = () => void;
type PendingState = { pendingText: string; flushScheduled: boolean };

function dispatchAgentEvent(
  event: AgentEvent,
  _dispatch: AgentLoopDispatch,
  pending: PendingState,
  flushText: FlushFn,
): void {
  switch (event.type) {
    case 'thinking_delta':
      _dispatch({ type: 'THINKING_DELTA', delta: event.delta });
      break;

    case 'text_delta':
      pending.pendingText += event.delta;
      if (!pending.flushScheduled) {
        pending.flushScheduled = true;
        queueMicrotask(flushText);
      }
      break;

    case 'tool_call_start':
      if (pending.pendingText) flushText();
      _dispatch({
        type: 'TOOL_START',
        id: event.toolCall.id,
        name: event.toolCall.name,
        input: event.toolCall.arguments,
      });
      break;

    case 'tool_call_result':
      _dispatch({
        type: 'TOOL_DONE',
        id: event.toolCall.id,
        result: event.isError
          ? { kind: 'error' as const, message: String(event.result ?? 'unknown error'), durationMs: event.durationMs }
          : { kind: 'ok' as const, content: String(event.result ?? ''), durationMs: event.durationMs },
      });
      break;

    case 'turn_complete':
      if (event.usage) {
        _dispatch({
          type: 'ACCUMULATE_USAGE',
          usage: {
            prompt_tokens: event.usage.prompt_tokens,
            completion_tokens: event.usage.completion_tokens,
            total_tokens: event.usage.total_tokens,
          },
        });
      }
      break;

    case 'agent_error':
      _dispatch({ type: 'STREAM_TEXT_DELTA', delta: `\n\nError: ${event.error.message}` });
      break;

    case 'thinking_done':
    case 'agent_done':
    case 'sub_agent_start':
    case 'sub_agent_event':
    case 'sub_agent_done':
    case 'budget_delegation':
    case 'budget_compact':
    case 'context_compacted':
      break;
  }
}

export function useAgentSubscription(agent: Agent) {
  const abortRef = useRef<AbortController | null>(null);

  const submit = useCallback(async (text: string, _dispatch: (a: UIAction) => void) => {
    const userId = `user-${nanoid()}`;
    const assistantId = `assistant-${nanoid()}`;

    _dispatch({ type: 'USER_SUBMIT', id: userId, content: text });
    _dispatch({ type: 'ASSISTANT_START', id: assistantId });
    _dispatch({ type: 'STREAMING_START' });

    const pending: PendingState = { pendingText: '', flushScheduled: false };

    function flushText() {
      if (pending.pendingText) {
        _dispatch({ type: 'STREAM_TEXT_DELTA', delta: pending.pendingText });
        pending.pendingText = '';
      }
      pending.flushScheduled = false;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      for await (const event of agent.runAgentLoop(
        { role: 'user', content: text, id: userId },
        undefined,
        { signal: controller.signal },
      ) as AsyncIterable<AgentEvent>) {
        dispatchAgentEvent(event, _dispatch, pending, flushText);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        flushText();
        _dispatch({ type: 'SET_INTERRUPTED', interrupted: true });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        flushText();
        _dispatch({ type: 'STREAM_TEXT_DELTA', delta: `\n\nError: ${msg}` });
      }
    }

    flushText();
    _dispatch({ type: 'FLUSH_TO_FINALIZED' });
    abortRef.current = null;
  }, [agent]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { submit, abort };
}
