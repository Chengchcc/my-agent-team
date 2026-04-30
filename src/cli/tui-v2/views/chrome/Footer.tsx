import React from 'react';
import { Box, Text } from 'ink';
import { useStatsSelector } from '../../state/selectors';
import { FOOTER_HINTS } from './keymap';

const TOKENS_PER_K = 1000;

export function Footer() {
  const totalTokens = useStatsSelector(s => s.totalTokens);
  const contextTokens = useStatsSelector(s => s.contextTokens);
  const streaming = useStatsSelector(s => s.streaming);

  return (
    <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
      <Text dimColor>{FOOTER_HINTS}</Text>
      <Box gap={1}>
        {totalTokens > 0 && (
          <Text dimColor>
            ctx: {(contextTokens / TOKENS_PER_K).toFixed(1)}k · total: {(totalTokens / TOKENS_PER_K).toFixed(1)}k
          </Text>
        )}
        <Text dimColor>{streaming ? '● streaming' : '○ idle'}</Text>
      </Box>
    </Box>
  );
}
