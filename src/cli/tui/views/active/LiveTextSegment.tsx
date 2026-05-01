import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { useSegmentFrame } from '../../streaming/committer';
import { renderMarkdownTokens } from '../../../tui/utils/render-markdown';

interface LiveTextSegmentProps {
  segId: string;
}

export const LiveTextSegment = React.memo(function LiveTextSegment({ segId }: LiveTextSegmentProps) {
  const frame = useSegmentFrame(segId);

  const rendered = useMemo(() => {
    if (!frame) return null;
    const stable = frame.content.slice(0, frame.committedLength);
    const tail = frame.content.slice(frame.committedLength);

    if (!stable && !tail) return null;

    return (
      <Box flexDirection="column">
        {stable ? renderMarkdownTokens(stable) : null}
        {tail ? <Text>{tail}</Text> : null}
      </Box>
    );
  }, [frame]);

  if (!rendered) {
    return (
      <Box height={1}>
        <Text>{' '}</Text>
      </Box>
    );
  }

  return rendered;
});
