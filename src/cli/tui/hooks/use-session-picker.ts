import { useCallback } from 'react';
import { useInput } from 'ink';
import { useTuiStore } from '../state/store';
import type { Agent } from '../../../agent';
import type { SessionStore } from '../../../session/store';

export function useSessionPicker(
  agent: Agent,
  sessionStore: SessionStore,
  noticIdx: React.MutableRefObject<number>,
) {
  const sessionPicker = useTuiStore(s => s.sessionPicker);

  const handleSelectSession = useCallback(
    async (index: number) => {
      const session = sessionPicker.sessions[index];
      if (!session) return;
      useTuiStore.getState().closeSessionPicker();

      try {
        const messages = await sessionStore.loadSession(session.id);
        agent.clear();
        const contextManager = agent.getContextManager();
        for (const msg of messages) {
          contextManager.addMessage(msg);
        }
        sessionStore.setCurrentSessionId(session.id);
        const msgs = contextManager.getMessages();
        useTuiStore.getState().resetFromMessages(msgs);
        useTuiStore.getState().appendSystemNotice(
          `notice-${noticIdx.current++}`,
          `Resumed session ${session.id} (${session.messageCount} messages)`,
        );
      } catch (error) {
        useTuiStore.getState().appendSystemNotice(
          `notice-${noticIdx.current++}`,
          `Failed to load session: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- noticIdx is a ref, stable across renders
    [sessionPicker.sessions, sessionStore, agent],
  );

  useInput((_input, key) => {
    if (!sessionPicker.active || sessionPicker.sessions.length === 0) return;
    if (key.upArrow) { useTuiStore.getState().sessionPickerMove(-1); return; }
    if (key.downArrow) { useTuiStore.getState().sessionPickerMove(1); return; }
    if (key.return) { void handleSelectSession(sessionPicker.selectedIndex); return; }
    if (key.escape) { useTuiStore.getState().closeSessionPicker(); }
  });

  return { sessionPicker };
}
