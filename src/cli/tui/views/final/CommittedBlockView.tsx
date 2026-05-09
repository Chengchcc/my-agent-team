import React, { useMemo } from 'react';
import { Box } from 'ink';
import { renderMarkdownTokens } from '../../utils/render-markdown';

export const CommittedBlockView = React.memo(function CommittedBlockView({ raw }: { raw: string }) {
  const nodes = useMemo(() => renderMarkdownTokens(raw), [raw]);
  if (nodes.length === 0) return null;
  return <Box paddingLeft={1} flexDirection="column">{nodes}</Box>;
});
