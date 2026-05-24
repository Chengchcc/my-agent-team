import { useEffect, useCallback, useRef } from 'react';
import { nanoid } from 'nanoid';
import type { Logger } from '../../../application/ports/logger';
import { useTuiStore } from '../state/store';
import { getCommitter } from '../streaming/committer';
import type { SessionClient } from '../session-client';
import type { TranscriptProjector } from '../transcript/projector';

export function useAgentSubscription(
  client: SessionClient,
  projector: TranscriptProjector,
  sessionId: string,
  logger?: Logger,
) {
  const abortRef = useRef<AbortController | null>(null);

  // Subscribe to transport events → push to projector
  useEffect(() => {
    const unsub = client.subscribeEvents(sessionId, (event) => {
      projector.pushDataplaneEvent(event);
    });
    return unsub;
  }, [client, projector, sessionId]);

  // Subscribe to projector transcript events → update TUI store
  useEffect(() => {
    // eslint-disable-next-line complexity -- pre-existing projector event handler
    const unsub = projector.onEvent((event) => {
      const store = useTuiStore.getState();
      const committer = getCommitter();

      switch (event.type) {
        case 'turn_started':
          store.turnStart('assistant-' + event.turnId);
          break;

        case 'assistant_text_delta':
          logger?.debug('tui', 'TRANSCRIPT text_delta' + JSON.stringify({ len: event.delta.length }));
          committer.onDelta(event.delta);
          break;

        case 'tool_call_started':
          logger?.debug('tui', 'TRANSCRIPT tool_call_started' + JSON.stringify({ callId: event.callId, name: event.name }));
          store.toolStart(event.callId, event.name, event.input);
          break;

        case 'tool_call_finished': {
          logger?.debug('tui', 'TRANSCRIPT tool_call_finished' + JSON.stringify({ callId: event.callId, isError: event.isError, durationMs: event.durationMs }));
          store.toolDone(event.callId, event.isError
            ? { kind: 'error', message: typeof event.result === 'string' ? event.result : JSON.stringify(event.result), durationMs: event.durationMs }
            : { kind: 'ok', content: typeof event.result === 'string' ? event.result : JSON.stringify(event.result), durationMs: event.durationMs },
          );
          committer.flush();
          break;
        }

        case 'turn_completed': {
          logger?.debug('tui', 'TRANSCRIPT turn_completed' + JSON.stringify({ finalMessageLen: event.finalMessage.length, usage: event.usage }));
          if (event.usage) {
            store.accumulateUsage({
              prompt_tokens: event.usage.input,
              completion_tokens: event.usage.output,
            });
          }
          // Track context tokens from accumulated usage
          const s = useTuiStore.getState().stats;
          store.setContextTokens((s.promptTokens || 0) + (s.completionTokens || 0));
          const hasToolCalls = false; // projector doesn't expose this, default to flush
          if (hasToolCalls) {
            committer.flush();
          } else {
            committer.onTurnDone();
          }
          break;
        }

        case 'assistant_text_final':
          // History replay: final text already rendered via history→finalized items
          break;

        case 'turn_failed': {
          logger?.debug('tui', 'TRANSCRIPT turn_failed' + JSON.stringify({ reason: event.reason }));
          committer.onDelta(`\n\n⚠ ${event.reason || 'Turn was interrupted'}`);
          break;
        }

        case 'system_notice':
          store.appendSystemNotice(nanoid(), event.message);
          break;

        case 'session_snapshot_loaded':
          // Batch-load all history records into finalized items
          store.resetFromMessages(event.records);
          break;

        case 'user_message':
          // Handled by batch-load above; no per-event action needed
          break;

        case 'widget_inline_block':
          store.appendWidget(event.blockId, event.widget, event.payload, event.mode);
          break;

        case 'compaction_started':
          store.setCompacting(true);
          break;
        case 'compaction_completed':
          store.setCompacting(false);
          break;
        case 'compaction_failed':
          store.setCompacting(false);
          store.appendSystemNotice('compaction-failed', `⚠ Token budget exceeded — turn aborted. Try /clear or /compact manually.`);
          break;

        case 'subagent_started':
          store.subagentStarted(event.callId, event.subagentType, Date.now());
          break;
        case 'subagent_completed':
          store.subagentCompleted(event.callId, event.finalText, event.usage, event.ok);
          break;

        case 'permission_requested':
        case 'user_question_requested':
          // Handled by other hooks
          break;
      }
    });
    return unsub;
  }, [projector, logger]);

  const submit = useCallback(
    async (text: string) => {
      const userId = 'user-' + nanoid();
      logger?.debug('tui', 'SUBMIT start' + JSON.stringify({ userId, textLen: text.length }));
      useTuiStore.getState().userSubmit(userId, text);
      useTuiStore.getState().streamingStart();

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await client.sendInput(sessionId, text);
      } catch (err: unknown) {
        const committer = getCommitter();
        const msg = err instanceof Error ? err.message : String(err);
        logger?.debug('tui', 'SUBMIT error' + JSON.stringify({ message: msg }));
        committer.onDelta(`\n\nError: ${msg}`);
        committer.onTurnDone();
      } finally {
        abortRef.current = null;
      }
    },
    [client, sessionId, logger],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    void client.cancelInput(sessionId, 'user requested');
    useTuiStore.getState().streamingStop();
  }, [client, sessionId]);

  return { submit, abort };
}
