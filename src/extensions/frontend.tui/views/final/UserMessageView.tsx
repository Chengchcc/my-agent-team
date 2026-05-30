import React from 'react';
import { Box, Text } from 'ink';

const PREFIX_FALLBACK_THRESHOLD = 200;

interface UserMessageViewProps {
  content: string;
}

export function UserMessageView({ content }: UserMessageViewProps) {
  const lines = content.split('\n');
  const overflowed = lines.length > PREFIX_FALLBACK_THRESHOLD;
  const decorated = overflowed
    ? content
    : lines.map((l) => `\u2502 ${l}`).join('\n');

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="cyan">{'>'} user</Text>
      </Box>
      <Box paddingLeft={1}>
        <Text color="cyan" dimColor={overflowed}>{decorated}</Text>
      </Box>
      {overflowed && (
        <Box paddingLeft={1}>
          <Text dimColor>({lines.length} lines, prefix omitted)</Text>
        </Box>
      )}
    </Box>
  );
}
