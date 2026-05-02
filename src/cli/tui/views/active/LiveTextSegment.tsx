import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { useSegmentFrame } from '../../streaming/committer';
import { getMarkdownRenderer } from '../../markdown/cache';
import { useTerminalWidth } from '../../hooks/use-terminal-width';

interface LiveTextSegmentProps {
  segId: string;
}

export function LiveTextSegment({ segId }: LiveTextSegmentProps) {
  const frame = useSegmentFrame(segId);
  const renderer = getMarkdownRenderer();
  const width = useTerminalWidth();

  const result = useMemo(() => {
    if (!frame) return { stable: [] as React.ReactNode[], tail: [] as React.ReactNode[] };
    return renderer.render(frame.content, frame.committedLength, width, frame.blocks, frame.definitions, frame.footnotes);
  }, [frame, renderer, width]);

  if (!frame || (result.stable.length === 0 && result.tail.length === 0)) {
    return (
      <Box height={1}>
        <Text>{' '}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {result.stable.length > 0 ? result.stable : null}
      {result.tail.length > 0 ? result.tail : null}
    </Box>
  );
}
