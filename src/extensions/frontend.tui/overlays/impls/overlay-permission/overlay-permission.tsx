import { Box, Text } from 'ink';
import React, { useCallback, useEffect, useRef } from 'react';
import type { PermissionRequest, PermissionResponse } from './use-permission-manager';
import type { KeyDispatcher } from '../../../input/key-dispatcher';
import { usePermissionManager } from './use-permission-manager';
import { ToolInputPreview } from './preview';
import type { OverlayDescriptor } from '../../overlay-types';

interface OverlayPermissionProps {
  request: PermissionRequest;
  respond: (response: PermissionResponse) => void;
  dismiss: () => void;
  keyDispatcher?: KeyDispatcher;
}

function OverlayPermission({ request, respond, dismiss, keyDispatcher }: OverlayPermissionProps) {
  const submittedRef = useRef(false);

  // Reset submitted flag when a new request comes in
  useEffect(() => {
    submittedRef.current = false;
  }, [request]);

  const handleSubmit = useCallback((response: PermissionResponse) => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    respond(response);
  }, [respond]);

  // Register as a KeyDispatcher layer — top priority while visible
  useEffect(() => {
    if (!keyDispatcher) return;
    const handler = (keyEvent: { escape?: boolean; return?: boolean; key?: string }) => {
      if (keyEvent.escape) { handleSubmit('deny'); return true; }
      if (keyEvent.key === 'y') { handleSubmit('allow'); return true; }
      if (keyEvent.key === 'a') { handleSubmit('always'); return true; }
      if (keyEvent.key === 'n') { handleSubmit('deny'); return true; }
      return false;
    };
    keyDispatcher.push({ id: 'permission-prompt', handler });
    return () => void keyDispatcher.pop('permission-prompt');
  }, [keyDispatcher, handleSubmit]);

  // Cleanup on unmount: dismiss if not already submitted (guard against double-resolve)
  useEffect(() => () => {
    if (!submittedRef.current) {
      submittedRef.current = true;
      dismiss();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional cleanup-only effect, dismiss is stable
  }, []);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Box>
        <Text bold color="yellow">Permission Required</Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          Allow <Text color="cyan">{request.toolName}</Text>?
        </Text>
      </Box>
      <Box>
        <Text dimColor>{request.reason}</Text>
      </Box>
      <ToolInputPreview toolName={request.toolName} input={request.input} />
      <Box marginTop={1}>
        <Text>
          <Text color="green">[y]</Text> allow once{'  '}
          <Text color="green">[a]</Text> always{'  '}
          <Text color="red">[N]</Text> deny{'  '}
          <Text dimColor>Esc</Text> deny
        </Text>
      </Box>
    </Box>
  );
}

export const overlayPermission: OverlayDescriptor<PermissionRequest, PermissionResponse> = {
  name: 'overlay.permission',
  Component: OverlayPermission,
  useManager: usePermissionManager,
};
