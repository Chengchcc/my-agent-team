import { useCallback, useRef } from 'react';
import { nanoid } from 'nanoid';
import { useTuiStore } from '../state/store';
import { getCommitter } from '../streaming/committer';
import { debugLog } from '../../../utils/debug';

const SUB_AGENT_TASK_PREVIEW_LEN = 150;
const SUB_AGENT_STATUS_PREVIEW_LEN = 200;
import type { Agent } from '../../../agent';
import type { AgentEvent } from '../../../agent/loop-types';

function dispatchAgentEvent(
  event: AgentEvent,
  agent: Agent,
): void {
  const store = useTuiStore.getState();
  const committer = getCommitter();

  switch (event.type) {
    case 'thinking_delta':
      break;

    case 'text_delta':
      debugLog('EVENT text_delta', { len: event.delta.length, turnIndex: event.turnIndex });
      committer.onDelta(event.delta);
      break;

    case 'tool_call_start':
      debugLog('EVENT tool_call_start', { id: event.toolCall.id, name: event.toolCall.name, turnIndex: event.turnIndex });
      store.toolStart(event.toolCall.id, event.toolCall.name, event.toolCall.arguments);
      break;

    case 'tool_call_result':
      debugLog('EVENT tool_call_result', { id: event.toolCall.id, isError: event.isError, durationMs: event.durationMs, turnIndex: event.turnIndex });
      store.toolDone(event.toolCall.id, event.isError
        ? { kind: 'error' as const, message: String(event.result ?? 'unknown error'), durationMs: event.durationMs }
        : { kind: 'ok' as const, content: String(event.result ?? ''), durationMs: event.durationMs },
      );
      committer.flush();
      break;

    case 'turn_complete': {
      debugLog('EVENT turn_complete', { hasToolCalls: event.hasToolCalls, turnIndex: event.turnIndex, finalizedLen: store.finalized.length });
      if (event.usage) {
        store.accumulateUsage({
          prompt_tokens: event.usage.prompt_tokens,
          completion_tokens: event.usage.completion_tokens,
        });
      }
      store.setContextTokens(agent.getContextManager().getCurrentTokens());
      if (event.hasToolCalls) {
        committer.flush();
      } else {
        committer.onTurnDone();
      }
      break;
    }

    case 'agent_error':
      debugLog('EVENT agent_error', { message: event.error.message, turnIndex: event.turnIndex });
      committer.onDelta(`\n\nError: ${event.error.message}`);
      break;

    case 'thinking_done':
      store.appendSystemNotice(`think-${nanoid()}`, 'Thinking complete');
      break;

    case 'agent_done': {
      const live = store.live;
      const liveDigest = live?.kind === 'assistant-message'
        ? `segs=${live.segments.length} status=${live.status}` : 'null';
      debugLog('EVENT agent_done', { reason: event.reason, totalTurns: event.totalTurns, live: liveDigest, finalizedLen: store.finalized.length });
      committer.onTurnDone();
      break;
    }

    case 'sub_agent_start':
      store.appendSystemNotice(`sub-${nanoid()}`, `Delegating to sub-agent: ${event.task.slice(0, SUB_AGENT_TASK_PREVIEW_LEN)}`);
      break;

    case 'sub_agent_event':
      break;

    case 'sub_agent_done':
      store.appendSystemNotice(
        `sub-done-${nanoid()}`,
        `Sub-agent finished (${event.totalTurns} turns, ${event.durationMs}ms): ${event.summary.slice(0, SUB_AGENT_STATUS_PREVIEW_LEN)}`,
      );
      break;

    case 'budget_delegation':
    case 'mcp_status':
      break;

    case 'budget_compact':
      debugLog('EVENT budget_compact', { turnIndex: event.turnIndex });
      store.setCompacting(true);
      break;

    case 'context_compacted':
      debugLog('EVENT context_compacted', { afterTokens: event.afterTokens, turnIndex: event.turnIndex });
      store.appendDivider('compact');
      store.setContextTokens(event.afterTokens);
      store.setCompacting(false);
      break;

    case 'evolution_review_done':
      store.addReviewNotification(event.skillName, event.description, event.outputDir);
      break;
  }
}

export function useAgentSubscription(agent: Agent) {
  const abortRef = useRef<AbortController | null>(null);

  /**
   * Pull-based event loop: each tick processes ONE agent event then yields
   * via setImmediate. This lets the Node.js event loop process stdin I/O
   * and React commit renders between every event, instead of the old
   * for-await model that consumed the poll phase entirely and starved stdin.
   */
  const submit = useCallback((text: string): Promise<void> => {
    const userId = `user-${nanoid()}`;
    const assistantId = `assistant-${nanoid()}`;

    debugLog('SUBMIT start', { userId, assistantId, textLen: text.length, finalizedLen: useTuiStore.getState().finalized.length });
    useTuiStore.getState().userSubmit(userId, text);
    useTuiStore.getState().turnStart(assistantId);
    useTuiStore.getState().streamingStart();

    const controller = new AbortController();
    abortRef.current = controller;

    const iterator = agent.runAgentLoop(
      { role: 'user', content: text, id: userId },
      undefined,
      { signal: controller.signal },
    )[Symbol.asyncIterator]();

    return new Promise<void>((resolve) => {
      const finish = () => {
        const committer = getCommitter();
        const liveExists = useTuiStore.getState().live != null;
        debugLog('SUBMIT finish', { liveExists });
        if (liveExists) {
          committer.onTurnDone();
        }
        abortRef.current = null;
        resolve();
      };

      const pullNext = () => {
        setImmediate(() => { void (async () => {
          try {
            const result = await iterator.next();
            if (result.done) {
              debugLog('SUBMIT iterator done');
              finish();
              return;
            }
            dispatchAgentEvent(result.value, agent);
            pullNext();
          } catch (err: unknown) {
            const committer = getCommitter();
            if (err instanceof DOMException && err.name === 'AbortError') {
              debugLog('SUBMIT aborted');
              committer.onTurnDone();
              useTuiStore.getState().setInterrupted(true);
            } else {
              const msg = err instanceof Error ? err.message : String(err);
              debugLog('SUBMIT error', { message: msg });
              committer.onDelta(`\n\nError: ${msg}`);
              committer.onTurnDone();
            }
            finish();
          }
        })(); });
      };

      pullNext();
    });
  }, [agent]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { submit, abort };
}
