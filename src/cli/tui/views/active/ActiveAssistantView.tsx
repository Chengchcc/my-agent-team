import React from 'react';
import { Box, Text } from 'ink';
import { LiveTextSegment } from './LiveTextSegment';
import { formatToolCallTitle } from '../../../tui/utils/tool-format';
import type { ToolCall } from '../../../../types';

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
    <Box flexDirection="column" paddingLeft={1}>
      {assistant.thinking ? (
        <Box>
          <Text dimColor>{'  '}{truncate(assistant.thinking, THINKING_TRUNCATION)}</Text>
        </Box>
      ) : null}
      {assistant.segments.map((seg) => {
        if (seg.kind === 'text') {
          return <LiveTextSegment key={seg.id} segId={seg.id} />;
        }
        // Only show running tools; done tools are already in <Static> as tool-call-final
        if (seg.status === 'running') {
          return <ActiveToolCallSegment key={seg.id} seg={seg} />;
        }
        return null;
      })}
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
    <Box>
      <Text color="yellow">◌ {title}</Text>
      <Text color="yellow"> running…</Text>
    </Box>
  );
});

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}
