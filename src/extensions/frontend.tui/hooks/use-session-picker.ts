import { useCallback, useEffect } from 'react';
import { useTuiStore } from '../state/store';
import type { SessionClient } from '../session-client';
import type { TranscriptProjector } from '../transcript/projector';
import type { KeyDispatcher, KeyEvent } from '../input/key-dispatcher';

export function useSessionPicker(
  client: SessionClient,
  projector: TranscriptProjector,
  noticIdx: React.MutableRefObject<number>,
  keyDispatcher: KeyDispatcher,
) {
  const sessionPicker = useTuiStore(s => s.sessionPicker);

  const handleSelectSession = useCallback(
    async (index: number) => {
      const session = sessionPicker.sessions[index];
      if (!session) return;
      useTuiStore.getState().closeSessionPicker();

      try {
        const result = await client.attachSession(session.id);
        const snapshot = (result.snapshot ?? []) as unknown as Parameters<typeof projector.loadHistory>[0];
        projector.loadHistory(snapshot);
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
    [sessionPicker.sessions, client, projector],
  );

  // Register as a KeyDispatcher layer while session picker is active
  useEffect(() => {
    if (!sessionPicker.active || sessionPicker.sessions.length === 0) return;
    const handler = (keyEvent: KeyEvent) => {
      if (keyEvent.key === 'escape') { useTuiStore.getState().closeSessionPicker(); return true; }
      if (keyEvent.key === 'enter') { void handleSelectSession(useTuiStore.getState().sessionPicker.selectedIndex); return true; }
      if (keyEvent.key === 'up') { useTuiStore.getState().sessionPickerMove(-1); return true; }
      if (keyEvent.key === 'down') { useTuiStore.getState().sessionPickerMove(1); return true; }
      return false;
    };
    keyDispatcher.push({ id: 'session-picker', handler });
    return () => void keyDispatcher.pop('session-picker');
  }, [sessionPicker.active, sessionPicker.sessions.length, keyDispatcher, handleSelectSession]);

  return { sessionPicker };
}
