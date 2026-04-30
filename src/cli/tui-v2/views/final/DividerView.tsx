import React from 'react';
import { Box, Text } from 'ink';

interface DividerViewProps {
  reason: 'clear' | 'compact';
}

export function DividerView({ reason }: DividerViewProps) {
  return (
    <Box marginY={1}>
      <Text dimColor>
        ─── {reason === 'clear' ? 'Conversation cleared' : 'Context compacted'} ───
      </Text>
    </Box>
  );
}
