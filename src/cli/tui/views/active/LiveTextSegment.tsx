import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { useSegmentFrame } from '../../streaming/committer';

interface LiveTextSegmentProps {
  segId: string;
}

export function LiveTextSegment({ segId }: LiveTextSegmentProps) {
  const frame = useSegmentFrame(segId);

  const tail = useMemo(() => {
    if (!frame) return null;

    const tailBlock = frame.blocks.find(b => b.endOffset > frame.committedLength);
    if (tailBlock) {
      return <Text>{tailBlock.raw.replace(/\n+$/, '')}</Text>;
    }
    if (frame.blocks.length === 0 && frame.committedLength < frame.content.length) {
      return <Text>{frame.content.slice(frame.committedLength)}</Text>;
    }
    return null;
  }, [frame]);

  if (!frame) {
    return (
      <Box height={1}>
        <Text>{' '}</Text>
      </Box>
    );
  }

  return <Box flexDirection="column">{tail}</Box>;
}
