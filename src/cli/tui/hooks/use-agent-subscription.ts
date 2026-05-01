import { useCallback, useRef } from 'react';
import { nanoid } from 'nanoid';
import { useTuiStore } from '../state/store';
import type { Agent } from '../../../agent';
import type { AgentEvent } from '../../../agent/loop-types';

function dispatchAgentEvent(
  event: AgentEvent,
  agent: Agent,
): void {
  const store = useTuiStore.getState();

  switch (event.type) {
    case 'thinking_delta':
      // No corresponding UI action in the new model; thinking is internal
      break;

    case 'text_delta':
      store.textDelta(event.delta);
      break;

    case 'tool_call_start':
      store.toolStart(event.toolCall.id, event.toolCall.name, event.toolCall.arguments);
      break;

    case 'tool_call_result':
      store.toolDone(event.toolCall.id, event.isError
        ? { kind: 'error' as const, message: String(event.result ?? 'unknown error'), durationMs: event.durationMs }
        : { kind: 'ok' as const, content: String(event.result ?? ''), durationMs: event.durationMs },
      );
      break;

    case 'turn_complete':
      if (event.usage) {
        store.accumulateUsage({
          prompt_tokens: event.usage.prompt_tokens,
          completion_tokens: event.usage.completion_tokens,
        });
      }
      store.setContextTokens(agent.getContextManager().getCurrentTokens());
      store.turnDone();
      store.streamingStop();
      break;

    case 'agent_error':
      store.textDelta(`\n\nError: ${event.error.message}`);
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

  const submit = useCallback(async (text: string) => {
    const userId = `user-${nanoid()}`;
    const assistantId = `assistant-${nanoid()}`;

    useTuiStore.getState().userSubmit(userId, text);
    useTuiStore.getState().turnStart(assistantId);
    useTuiStore.getState().streamingStart();

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      for await (const event of agent.runAgentLoop(
        { role: 'user', content: text, id: userId },
        undefined,
        { signal: controller.signal },
      ) as AsyncIterable<AgentEvent>) {
        dispatchAgentEvent(event, agent);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        useTuiStore.getState().turnDone();
        useTuiStore.getState().streamingStop();
        useTuiStore.getState().setInterrupted(true);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        useTuiStore.getState().textDelta(`\n\nError: ${msg}`);
        useTuiStore.getState().turnDone();
        useTuiStore.getState().streamingStop();
      }
    }

    abortRef.current = null;
  }, [agent]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { submit, abort };
}
