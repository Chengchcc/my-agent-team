import React from 'react';
import { Box, Text } from 'ink';

interface UserMessageViewProps {
  content: string;
}

export function UserMessageView({ content }: UserMessageViewProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="cyan">{'>'} user</Text>
      </Box>
      <Box paddingLeft={1}>
        <Text color="cyan">{content}</Text>
      </Box>
    </Box>
  );
}
