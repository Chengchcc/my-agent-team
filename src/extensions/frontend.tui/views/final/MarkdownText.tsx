import React from 'react';
import { Box } from 'ink';
import { renderMarkdownTokens } from '../../utils/render-markdown';

interface MarkdownTextProps {
  content: string;
}

export function MarkdownText({ content }: MarkdownTextProps) {
  if (!content) return null;
  return (
    <Box flexDirection="column">
      {renderMarkdownTokens(content)}
    </Box>
  );
}
