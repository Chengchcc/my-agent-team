import React from 'react';
import { Box, Text } from 'ink';
import { useStatsSelector } from '../../state/selectors';

export function StreamingIndicator() {
  const streaming = useStatsSelector(s => s.streaming);
  const streamingStartTime = useStatsSelector(s => s.streamingStartTime);
  const interrupted = useStatsSelector(s => s.interrupted);

  if (!streaming && !interrupted) return null;

  const MS_PER_SECOND = 1000;
  const elapsed = streamingStartTime ? Math.floor((Date.now() - streamingStartTime) / MS_PER_SECOND) : 0;

  return (
    <Box>
      {interrupted ? (
        <Text color="yellow">⚠ interrupted after {elapsed}s</Text>
      ) : (
        <Text color="yellow">⠋ thinking ({elapsed}s)</Text>
      )}
    </Box>
  );
}
