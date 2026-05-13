import React, { useMemo, useCallback, useRef, useEffect, useState } from 'react';
import { Box, Static } from 'ink';
import { useTuiStore, useFrozenItems, useLiveItem, useStreaming } from './state/store';
import { FinalItemView } from './views/final/FinalItemView';
import { ActiveAssistantView } from './views/active/ActiveAssistantView';
import { FocusedToolDetail } from './views/overlay/FocusedToolDetail';
import { InputBox, type InputBoxCallbacks } from './views/chrome/InputBox';
import { Footer } from './views/chrome/Footer';
import { StreamingIndicator } from './views/chrome/StreamingIndicator';
import { useAgentSubscription } from './hooks/use-agent-subscription';
import { getBuiltinCommands } from './command-registry';
import { useAskUserQuestionManager } from './hooks/use-ask-user-question-manager';
import { usePermissionManager } from './hooks/use-permission-manager';
import { AskUserQuestionPrompt } from './views/overlay/AskUserQuestionPrompt';
import { PermissionPrompt } from './views/overlay/PermissionPrompt';
import { ReviewNotifications } from './components/ReviewNotification';
import { TodoPanel } from './components/TodoPanel';
import type { PromptSubmission, SlashCommand } from './command-registry';
import type { CommandHandlerContext } from './types';
import type { Agent } from '../../agent';
import type { SessionStore } from '../../session/store';
import type { FinalItem } from './state/types';
import type { LiveAssistant } from './state/store';
import { getMcpManagerInstance } from '../../mcp/index';

interface AppProps {
  agent: Agent;
  sessionStore: SessionStore;
  skillCommands: SlashCommand[];
}

function finalItemKey(item: FinalItem): string {
  if (item.kind === 'banner') return 'banner';
  if (item.kind === 'divider') return `divider-${item.reason}`;
  return item.id ?? 'unknown';
}

function buildV2CommandContext(
  agent: Agent,
  sessionStore: SessionStore,
  noticIdx: React.MutableRefObject<number>,
  args: string,
): CommandHandlerContext {
  return {
    agent,
    sessionStore,
    args,
    onOutput: (content) => useTuiStore.getState().appendSystemNotice(`notice-${noticIdx.current++}`, content),
    refreshMessages: () => {
      const cm = agent.getContextManager?.();
      const msgs = cm?.getMessages?.() ?? [];
      useTuiStore.getState().resetFromMessages(msgs);
      useTuiStore.getState().setContextTokens(cm?.getCurrentTokens() ?? 0);
    },
    mcpManager: getMcpManagerInstance() ?? undefined,
  };
}

function getFocusableToolIds(): string[] {
  const s = useTuiStore.getState();
  const ids: string[] = [];
  // Check the live item first
  if (s.live?.kind === 'assistant-message') {
    for (const seg of s.live.segments) {
      if (seg.kind === 'tool_call') ids.push(seg.id);
    }
  }
  // Then check the last done assistant-message in finalized
  for (let i = s.finalized.length - 1; i >= 0; i--) {
    const item = s.finalized[i]!;
    if (item.kind === 'assistant-message') {
      for (const seg of item.segments) {
        if (seg.kind === 'tool_call') ids.push(seg.id);
      }
      break;
    }
  }
  return ids;
}

async function handleBuiltinCommand(
  text: string, agent: Agent, sessionStore: SessionStore,
  noticIdx: React.MutableRefObject<number>,
  setStaticKey: React.Dispatch<React.SetStateAction<number>>,
): Promise<boolean> {
  if (text === '/clear' || text === '/cls') {
    agent.clear?.();
    sessionStore.createNewSession();
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    setStaticKey(k => k + 1);
    useTuiStore.getState().clearActive();
    return true;
  }
  if (text === '/compact') {
    const contextManager = agent.getContextManager?.();
    if (contextManager) {
      useTuiStore.getState().setCompacting(true);
      setTimeout(() => {
        contextManager.forceCompact()
          .finally(() => useTuiStore.getState().setCompacting(false))
          .catch(() => {});
      }, 0);
      useTuiStore.getState().appendDivider('compact');
    }
    return true;
  }
  if (text === '/exit' || text === '/quit') {
    process.exit(0);
  }
  if (text.startsWith('/')) {
    const match = text.match(/^\/([^\s]+)(?:\s(.*))?$/);
    if (match) {
      const commandName = match[1]!.toLowerCase();
      const args = match[2] || '';
      const matched = getBuiltinCommands(sessionStore).find(c => c.name.toLowerCase() === commandName && c.handler);
      if (matched) {
        await matched.handler!(buildV2CommandContext(agent, sessionStore, noticIdx, args));
        return true;
      }
    }
  }
  return false;
}

export function AppV2({ agent, sessionStore, skillCommands }: AppProps) {
  const noticIdx = useRef(0);
  const pendingRef = useRef<string[]>([]);
  const [staticKey, setStaticKey] = useState(0);

  const { submit, abort } = useAgentSubscription(agent);
  const { askUserQuestionRequest, respondWithAnswers } = useAskUserQuestionManager();
  const { permissionRequest, respondToPermission } = usePermissionManager();

  const streaming = useStreaming();

  const handleSubmit = useCallback(
    async (submission: PromptSubmission) => {
      if (streaming) {
        pendingRef.current.push(submission.text);
        useTuiStore.getState().enqueuePendingInput(submission.text);
        return;
      }

      const text = submission.text.trim();
      const handled = await handleBuiltinCommand(text, agent, sessionStore, noticIdx, setStaticKey);
      if (handled) return;

      const messageText = submission.requestedSkillName
        ? `Please use the "${submission.requestedSkillName}" skill for this request. ${submission.text}`
        : submission.text;

      await submit(messageText);

      while (pendingRef.current.length > 0) {
        const pending = [...pendingRef.current];
        pendingRef.current = [];
        for (const next of pending) {
          useTuiStore.getState().dequeuePendingInput();
          await submit(next);
        }
      }
    },
    [submit, agent, sessionStore, streaming],
  );

  const handleAbort = useCallback(() => {
    abort();
    useTuiStore.getState().setInterrupted(true);
  }, [abort]);

  const handleFocusPrev = useCallback(() => {
    const toolIds = getFocusableToolIds();
    useTuiStore.getState().moveFocus(-1, toolIds);
  }, []);

  const handleFocusNext = useCallback(() => {
    const toolIds = getFocusableToolIds();
    useTuiStore.getState().moveFocus(1, toolIds);
  }, []);

  const handleToggleExpand = useCallback(() => {
    useTuiStore.getState().toggleExpanded();
  }, []);

  const callbacks: InputBoxCallbacks = useMemo(
    () => ({
      onFocusPrev: handleFocusPrev,
      onFocusNext: handleFocusNext,
      onToggleExpand: handleToggleExpand,
      onClearPending: () => {
        pendingRef.current = [];
        useTuiStore.getState().clearPendingInputs();
      },
    }),
    [handleFocusPrev, handleFocusNext, handleToggleExpand],
  );

  // Initialize context tracking + todo state (covers resume path)
  useEffect(() => {
    const cm = agent.getContextManager?.();
    if (!cm) return;
    useTuiStore.getState().setTokenLimit(cm.getTokenLimit());
    useTuiStore.getState().setContextTokens(cm.getCurrentTokens());
    const todoState = cm.getTodoState();
    useTuiStore.getState().updateTodos(todoState.todos);
  }, [agent]);

  const allCommands = useMemo(() => [...getBuiltinCommands(sessionStore), ...skillCommands], [sessionStore, skillCommands]);

  const banner: FinalItem = useMemo(
    () => ({ kind: 'banner' as const, model: agent.getModelName(), sessionId: sessionStore.getSessionId() }),
    [agent, sessionStore],
  );

  const frozenItems = useFrozenItems();
  const liveItem = useLiveItem();

  const staticItems = useMemo(() => [banner, ...frozenItems], [banner, frozenItems]);

  const activeAssistant = useMemo(
    () => liveItem?.kind === 'assistant-message' ? toActiveAssistant(liveItem) : null,
    [liveItem],
  );

  const showPrompt = askUserQuestionRequest != null || permissionRequest != null;

  return (
    <Box flexDirection="column">
      <Static key={staticKey} items={staticItems}>
        {(item) => <FinalItemView key={finalItemKey(item)} item={item} />}
      </Static>
      <Box flexDirection="column">
        {activeAssistant != null && (
          <ActiveAssistantView assistant={activeAssistant} />
        )}
        <StreamingIndicator />
        <FocusedToolDetail />
        <ReviewNotifications />
        <TodoPanel />
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
            onSubmit={(s) => { void handleSubmit(s); }}
            onAbort={handleAbort}
            callbacks={callbacks}
          />
        )}
        <Footer />
      </Box>
    </Box>
  );
}

// ── Compatibility adapter for ActiveAssistantView ──

interface CompatActiveAssistant {
  id: string;
  segments: Array<
    | { kind: 'text'; id: string; content: string }
    | { kind: 'tool_call'; id: string; name: string; input: unknown; result: { kind: 'ok'; content: string; durationMs: number } | { kind: 'error'; message: string; durationMs: number } | null; status: 'running' | 'done' | 'error' }
  >;
  thinking: null;
}

function toActiveAssistant(item: LiveAssistant): CompatActiveAssistant {
  return {
    id: item.id,
    thinking: null,
    segments: item.segments.map((seg): CompatActiveAssistant['segments'][number] => {
      if (seg.kind === 'text') {
        return { kind: 'text', id: seg.id, content: seg.content };
      }
      // tool_call: derive status from result presence
      const result = seg.result;
      let status: 'running' | 'done' | 'error' = 'running';
      if (result) {
        status = result.kind === 'error' ? 'error' : 'done';
      }
      return {
        kind: 'tool_call',
        id: seg.id,
        name: seg.name,
        input: seg.input,
        result,
        status,
      };
    }),
  };
}
