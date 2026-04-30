import React from 'react';
import { Box, Text } from 'ink';
import { MarkdownText } from './MarkdownText';
import { FinalToolCallView } from './FinalToolCallView';
import type { AssistantSegment } from '../../state/types';

interface AssistantMessageViewProps {
  segments: AssistantSegment[];
}

export function AssistantMessageView({ segments }: AssistantMessageViewProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text dimColor>{'<'} </Text>
        <Text>assistant:</Text>
      </Box>
      <Box paddingLeft={1} flexDirection="column">
        {segments.map((seg, i) => {
          if (seg.kind === 'text') {
            return <MarkdownText key={i} content={seg.content} />;
          }
          return (
            <FinalToolCallView
              key={seg.id}
              call={seg as typeof seg & { result: NonNullable<(typeof seg)['result']> }}
            />
          );
        })}
      </Box>
    </Box>
  );
}
