import React, { useMemo } from 'react';
import { Box, Text } from 'ink';

export const AssistantTailView = React.memo(function AssistantTailView({ raw }: { raw: string }) {
  const text = useMemo(() => raw.replace(/\n+$/, ''), [raw]);
  if (!text) return null;
  return (
    <Box paddingLeft={1}>
      <Text>{text}</Text>
    </Box>
  );
});
