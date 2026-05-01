import React from 'react';
import { Box, Text } from 'ink';
import { LiveTextSegment } from './LiveTextSegment';
import { formatToolCallTitle } from '../../../tui/utils/tool-format';
import type { ToolCall } from '../../../../types';

// Local types matching the compatibility adapter in App.tsx
interface CompatTextSeg { kind: 'text'; id: string; content: string }
interface CompatToolSeg { kind: 'tool_call'; id: string; name: string; input: unknown; result: { kind: 'ok'; content: string; durationMs: number } | { kind: 'error'; message: string; durationMs: number } | null; status: 'running' | 'done' | 'error' }
type CompatSeg = CompatTextSeg | CompatToolSeg;

type StreamingAssistant = { id: string; segments: CompatSeg[]; thinking: string | null };

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
        {assistant.segments.map((seg) => {
          if (seg.kind === 'text') {
            return <LiveTextSegment key={seg.id} segId={seg.id} />;
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

const ActiveToolCallSegment = React.memo(function ActiveToolCallSegment({ seg }: { seg: CompatToolSeg }) {
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
