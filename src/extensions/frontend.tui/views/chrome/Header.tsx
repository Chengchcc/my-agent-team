import React from 'react';
import { Box, Text } from 'ink';
import { useTuiStore } from '../../state/store';

const SESSION_ID_DISPLAY_LENGTH = 8;

const HAMSTER_LOGO = `\
▄█▄█▄
█●█●█
▀███▀
 █ █`;

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
  const interrupted = useTuiStore(s => s.stats.interrupted);
  const mode = useTuiStore(s => s.stats.mode);
  const status = interrupted ? 'interrupted' as const : 'connected' as const;
  const st = STATUS_DOTS[status]!;

  return (
    <Box flexDirection="row" alignItems="center" gap={1} width="100%" justifyContent="space-between">
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Text>{HAMSTER_LOGO}</Text>
        <Text>
          <Text bold color="cyan">my-agent</Text>
          {model ? <Text dimColor> - {model}</Text> : null}
          {mode !== 'normal' ? <Text bold color="magenta"> [{mode}]</Text> : null}
          <Text dimColor> - </Text>
          <Text color={st.color}>{st.char}</Text>
          <Text dimColor> {st.label}</Text>
        </Text>
      </Box>
      {sessionId ? <Text dimColor>session:{sessionId.slice(0, SESSION_ID_DISPLAY_LENGTH)}</Text> : null}
    </Box>
  );
}
