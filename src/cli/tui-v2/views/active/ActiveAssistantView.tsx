import React from 'react';
import { Box, Text } from 'ink';
import { MarkdownStreamText } from './MarkdownStreamText';
import { formatToolCallTitle } from '../../../tui/utils/tool-format';
import type { ToolCall } from '../../../../types';
import type { ActiveState, ActiveSegment } from '../../state/types';

type StreamingAssistant = NonNullable<ActiveState['streamingAssistant']>;

const THINKING_TRUNCATION = 100;

interface ActiveAssistantViewProps {
  assistant: StreamingAssistant;
}

export function ActiveAssistantView({ assistant }: ActiveAssistantViewProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text dimColor>{'<'} </Text>
        <Text>assistant:</Text>
      </Box>
      <Box paddingLeft={1} flexDirection="column">
        {assistant.thinking ? (
          <Box>
            <Text dimColor>{'  '}{truncate(assistant.thinking, THINKING_TRUNCATION)}</Text>
          </Box>
        ) : null}
        {assistant.segments.map((seg: ActiveSegment, i: number) => {
          if (seg.kind === 'text') {
            return <MarkdownStreamText key={i} content={seg.content} />;
          }
          return (
            <ActiveToolCallSegment key={seg.id} seg={seg} />
          );
        })}
      </Box>
    </Box>
  );
}

function getToolCallTitle(name: string, input: unknown): string {
  const args: Record<string, unknown> = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
  return formatToolCallTitle({ id: '', name, arguments: args } satisfies ToolCall);
}

const ActiveToolCallSegment = React.memo(function ActiveToolCallSegment({ seg }: { seg: ActiveSegment & { kind: 'tool_call' } }) {
  const title = getToolCallTitle(seg.name, seg.input);
  return (
    <Box paddingX={1}>
      <Text color={seg.status === 'running' ? 'yellow' : seg.status === 'error' ? 'red' : 'gray'}>
        {seg.status === 'running' ? '◌' : '●'} {title}
      </Text>
      {seg.status === 'running' ? <Text color="yellow"> running…</Text> : null}
      {seg.result ? <Text color="gray"> {seg.result.durationMs}ms</Text> : null}
    </Box>
  );
});

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}
