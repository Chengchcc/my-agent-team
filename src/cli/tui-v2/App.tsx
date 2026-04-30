import React, { useReducer, useMemo, useCallback, useRef, useState } from 'react';
import { Box, Static, useInput } from 'ink';
import { uiReducer, initialUIState } from './state/dispatch';
import {
  FinalizedContext,
  ActiveContext,
  InteractionContext,
  StatsContext,
} from './state/selectors';
import { FinalItemView } from './views/final/FinalItemView';
import { ActiveAssistantView } from './views/active/ActiveAssistantView';
import { FocusedToolDetail } from './views/overlay/FocusedToolDetail';
import { InputBox, type InputBoxCallbacks } from './views/chrome/InputBox';
import { Footer } from './views/chrome/Footer';
import { StreamingIndicator } from './views/chrome/StreamingIndicator';
import { useAgentSubscription } from './hooks/use-agent-subscription';
import { getBuiltinCommands } from '../tui/command-registry';
import { useAskUserQuestionManager } from '../tui/hooks/use-ask-user-question-manager';
import { usePermissionManager } from '../tui/hooks/use-permission-manager';
import { AskUserQuestionPrompt } from '../tui/components/AskUserQuestionPrompt';
import { PermissionPrompt } from '../tui/components/PermissionPrompt';
import type { PromptSubmission, SlashCommand } from '../tui/command-registry';
import type { Agent } from '../../agent';
import type { SessionStore } from '../../session/store';
import type { ActiveState, FinalItem } from './state/types';
import type { AskUserQuestionRequest, AskUserQuestionResult } from '../../tools';
import type { PermissionRequest, PermissionResponse } from '../../tools';

interface AppProps {
  agent: Agent;
  sessionStore: SessionStore;
  skillCommands: SlashCommand[];
}

function finalItemKey(item: { kind: string; id?: string; reason?: string }): string {
  if (item.kind === 'banner') return 'banner';
  if (item.kind === 'divider') return `divider-${item.reason ?? 'unknown'}`;
  return item.id ?? 'unknown';
}

export function AppV2({ agent, sessionStore, skillCommands }: AppProps) {
  const [state, dispatch] = useReducer(uiReducer, initialUIState);
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  const { submit, abort } = useAgentSubscription(agent);
  const { askUserQuestionRequest, respondWithAnswers } = useAskUserQuestionManager();
  const { permissionRequest, respondToPermission } = usePermissionManager();

  const stateRef = useRef(state);
  stateRef.current = state;

  const streamingRef = useRef(state.stats.streaming);
  streamingRef.current = state.stats.streaming;

  // Pending input queue — ref for actual data, dispatch for UI
  const pendingRef = useRef<string[]>([]);

  const handleSubmit = useCallback(
    async (submission: PromptSubmission) => {
      // During streaming, enqueue as pending
      if (streamingRef.current) {
        pendingRef.current.push(submission.text);
        dispatchRef.current({ type: 'ENQUEUE_PENDING_INPUT', text: submission.text });
        return;
      }

      const text = submission.text.trim();

      if (text === '/clear' || text === '/cls') {
        agent.clear?.();
        dispatchRef.current({ type: 'APPEND_DIVIDER', reason: 'clear' });
        dispatchRef.current({ type: 'CLEAR_ACTIVE' });
        return;
      }
      if (text === '/compact') {
        dispatchRef.current({ type: 'APPEND_DIVIDER', reason: 'compact' });
        const contextManager = agent.getContextManager?.();
        if (contextManager) {
          // Fire-and-forget — compaction can be slow (LLM summarisation)
          contextManager.forceCompact().catch(() => {});
        }
        return;
      }
      if (text === '/exit' || text === '/quit') {
        process.exit(0);
        return;
      }

      if (text.startsWith('/')) {
        const match = text.match(/^\/([^\s]+)(?:\s(.*))?$/);
        if (match) {
          const commandName = match[1]!.toLowerCase();
          const args = match[2] || '';
          const builtinCommands = getBuiltinCommands(sessionStore);
          const matched = builtinCommands.find(c => c.name.toLowerCase() === commandName && c.handler);
          if (matched) {
            await matched.handler!({
              agent,
              sessionStore,
              onOutput: (_content: string) => {},
              refreshMessages: () => {},
              args,
            });
            return;
          }
        }
      }

      const messageText = submission.requestedSkillName
        ? `Please use the "${submission.requestedSkillName}" skill for this request. ${submission.text}`
        : submission.text;

      await submit(messageText, dispatchRef.current);

      // Drain pending input queue — snapshot to prevent concurrent
      // modification if new inputs are enqueued during drain.
      while (pendingRef.current.length > 0) {
        const pending = [...pendingRef.current];
        pendingRef.current = [];
        for (const next of pending) {
          dispatchRef.current({ type: 'DEQUEUE_PENDING_INPUT' });
          await submit(next, dispatchRef.current);
        }
      }
    },
    [submit, agent, sessionStore],
  );

  const handleAbort = useCallback(() => {
    abort();
    dispatchRef.current({ type: 'SET_INTERRUPTED', interrupted: true });
  }, [abort]);

  const handleFocusPrev = useCallback(() => {
    const toolIds = getFocusableToolIds(stateRef.current);
    dispatchRef.current({ type: 'MOVE_FOCUS', direction: -1, collapsibleToolIds: toolIds });
  }, []);

  const handleFocusNext = useCallback(() => {
    const toolIds = getFocusableToolIds(stateRef.current);
    dispatchRef.current({ type: 'MOVE_FOCUS', direction: 1, collapsibleToolIds: toolIds });
  }, []);

  const handleToggleExpand = useCallback(() => {
    dispatchRef.current({ type: 'TOGGLE_EXPANDED' });
  }, []);

  const handleClearPending = useCallback(() => {
    pendingRef.current = [];
    dispatchRef.current({ type: 'CLEAR_PENDING_INPUTS' });
  }, []);

  const [_thinkingCollapsed, setThinkingCollapsed] = useState(true);
  const handleToggleThinking = useCallback(() => {
    setThinkingCollapsed(prev => !prev);
  }, []);

  const [_debugShow, setDebugShow] = useState(false);
  const handleToggleDebug = useCallback(() => {
    setDebugShow(prev => !prev);
  }, []);

  const callbacks: InputBoxCallbacks = useMemo(
    () => ({
      onFocusPrev: handleFocusPrev,
      onFocusNext: handleFocusNext,
      onToggleExpand: handleToggleExpand,
      onClearPending: handleClearPending,
      onToggleThinking: handleToggleThinking,
      onToggleDebug: handleToggleDebug,
    }),
    [handleFocusPrev, handleFocusNext, handleToggleExpand, handleClearPending, handleToggleThinking, handleToggleDebug],
  );

  const allCommands = useMemo(() => [...getBuiltinCommands(sessionStore), ...skillCommands], [sessionStore, skillCommands]);

  // agent and sessionStore are stable references, no need to include in deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const itemsWithBanner = useMemo(() => [
    { kind: 'banner' as const, model: agent.getModelName(), sessionId: sessionStore.getSessionId() },
    ...state.finalizedItems,
  ], [state.finalizedItems]);

  const showPrompt = askUserQuestionRequest != null || permissionRequest != null;

  return (
    <FinalizedContext.Provider value={itemsWithBanner}>
      <ActiveContext.Provider value={state.active}>
        <InteractionContext.Provider value={state.interaction}>
          <StatsContext.Provider value={state.stats}>
            <AppLayout
              itemsWithBanner={itemsWithBanner}
              active={state.active}
              showPrompt={showPrompt}
              askUserQuestionRequest={askUserQuestionRequest}
              permissionRequest={permissionRequest}
              respondWithAnswers={respondWithAnswers}
              respondToPermission={respondToPermission}
              allCommands={allCommands}
              handleSubmit={(s) => { void handleSubmit(s); }}
              handleAbort={handleAbort}
              callbacks={callbacks}
            />
          </StatsContext.Provider>
        </InteractionContext.Provider>
      </ActiveContext.Provider>
    </FinalizedContext.Provider>
  );
}

function getFocusableToolIds(state: ReturnType<typeof uiReducer>): string[] {
  const ids: string[] = [];
  if (state.active.streamingAssistant) {
    for (const seg of state.active.streamingAssistant.segments) {
      if (seg.kind === 'tool_call') ids.push(seg.id);
    }
  }
  for (let i = state.finalizedItems.length - 1; i >= 0; i--) {
    const item = state.finalizedItems[i]!;
    if (item.kind === 'assistant-message') {
      for (const seg of item.segments) {
        if (seg.kind === 'tool_call') ids.push(seg.id);
      }
      break;
    }
  }
  return ids;
}

// ── Inner layout (separated to keep AppV2 under the 150-line limit) ──

interface AppLayoutProps {
  itemsWithBanner: FinalItem[];
  active: ActiveState;
  showPrompt: boolean;
  askUserQuestionRequest: AskUserQuestionRequest | null;
  permissionRequest: PermissionRequest | null;
  respondWithAnswers: (result: AskUserQuestionResult) => void;
  respondToPermission: (response: PermissionResponse) => void;
  allCommands: SlashCommand[];
  handleSubmit: (submission: PromptSubmission) => void;
  handleAbort: () => void;
  callbacks: InputBoxCallbacks;
}

function AppLayout({
  itemsWithBanner,
  active,
  showPrompt,
  askUserQuestionRequest,
  permissionRequest,
  respondWithAnswers,
  respondToPermission,
  allCommands,
  handleSubmit,
  handleAbort,
  callbacks,
}: AppLayoutProps) {
  // Global keyboard shortcuts active when InputBox is hidden (permission / ask-question prompts).
  // PermissionPrompt handles y/a/n via its own useInput.
  useInput((_input, key) => {
    if (key.escape) {
      handleAbort();
      return;
    }
    if (key.upArrow && key.ctrl) {
      callbacks.onFocusPrev?.();
      return;
    }
    if (key.downArrow && key.ctrl) {
      callbacks.onFocusNext?.();
      return;
    }
  }, { isActive: showPrompt });

  return (
    <Box flexDirection="column">
      <Static items={itemsWithBanner}>
        {(item) => <FinalItemView key={finalItemKey(item)} item={item} />}
      </Static>
      <Box flexDirection="column">
        {active.streamingAssistant != null && (
          <ActiveAssistantView assistant={active.streamingAssistant} />
        )}
        <StreamingIndicator />
        <FocusedToolDetail finalizedItems={itemsWithBanner} active={active} />
        {askUserQuestionRequest != null && (
          <AskUserQuestionPrompt
            questions={askUserQuestionRequest.params.questions}
            onSubmit={respondWithAnswers}
          />
        )}
        {permissionRequest != null && (
          <PermissionPrompt
            request={permissionRequest}
            onSubmit={respondToPermission}
          />
        )}
        {!showPrompt && (
          <InputBox
            commands={allCommands}
            onSubmit={(s) => {
              handleSubmit(s);
            }}
            onAbort={handleAbort}
            callbacks={callbacks}
          />
        )}
        <Footer />
      </Box>
    </Box>
  );
}
