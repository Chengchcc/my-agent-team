import React from 'react';
import { Box, Text } from 'ink';

export const AssistantHeaderView = React.memo(function AssistantHeaderView() {
  return (
    <Box>
      <Text dimColor>{'<'} </Text>
      <Text>assistant:</Text>
    </Box>
  );
});
