import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { useSegmentFrame } from '../../streaming/committer';
import { getMarkdownRenderer } from '../../markdown/cache';

interface LiveTextSegmentProps {
  segId: string;
}

export const LiveTextSegment = React.memo(function LiveTextSegment({ segId }: LiveTextSegmentProps) {
  const frame = useSegmentFrame(segId);
  const renderer = getMarkdownRenderer();

  // useMemo guards against re-rendering when the committer returns the same
  // SegFrame reference (content + committedLength unchanged).
  const result = useMemo(() => {
    if (!frame) return { stable: [] as React.ReactNode[], tail: [] as React.ReactNode[] };
    return renderer.render(frame.content, frame.committedLength);
  }, [frame, renderer]);

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
});
