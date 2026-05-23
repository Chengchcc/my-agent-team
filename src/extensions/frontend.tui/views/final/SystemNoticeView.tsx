import React from 'react';
import { Box, Text } from 'ink';

interface SystemNoticeViewProps {
  content: string;
}

export const SystemNoticeView = React.memo(function SystemNoticeView({ content }: SystemNoticeViewProps) {
  return (
    <Box>
      <Text dimColor>{content}</Text>
    </Box>
  );
});
