import React from 'react';
import { Box, Text } from 'ink';
import { useStatsSelector } from '../../state/selectors';

const SESSION_ID_DISPLAY_LENGTH = 8;

const STATUS_DOTS: Record<string, { char: string; color: string; label: string }> = {
  connected:    { char: '*', color: 'green',  label: 'connected' },
  interrupted:  { char: 'x', color: 'red',    label: 'interrupted' },
  reconnecting: { char: '~', color: 'yellow', label: 'reconnecting' },
};

interface HeaderProps {
  model: string;
  sessionId: string | null;
}

export function Header({ model, sessionId }: HeaderProps) {
  const interrupted = useStatsSelector(s => s.interrupted);
  const status = interrupted ? 'interrupted' as const : 'connected' as const;
  const st = STATUS_DOTS[status]!;

  return (
    <Box flexDirection="row" alignItems="center" gap={1} width="100%" justifyContent="space-between">
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Text bold color="cyan">my-agent</Text>
        {model ? <Text dimColor> - {model}</Text> : null}
        <Text dimColor> - </Text>
        <Text color={st.color}>{st.char}</Text>
        <Text dimColor> {st.label}</Text>
      </Box>
      {sessionId ? <Text dimColor>session:{sessionId.slice(0, SESSION_ID_DISPLAY_LENGTH)}</Text> : null}
    </Box>
  );
}
