import React from 'react';
import { Box, Text } from 'ink';

export function BannerView() {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color="magenta">
          ╭────────────────────────────────────────────╮
        </Text>
      </Box>
      <Box>
        <Text bold color="magenta">
          │ My Agent v0.1.0                            │
        </Text>
      </Box>
      <Box>
        <Text bold color="magenta">
          ╰────────────────────────────────────────────╯
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Type /help for commands</Text>
      </Box>
    </Box>
  );
}
