import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ToolCallSegment, ToolCallResult } from '../../state/types';
import { formatToolCallTitle, smartSummarize } from '../../../tui/utils/tool-format';
import type { ToolCall } from '../../../../types';

const RESULT_TRUNCATION = 200;

interface FinalToolCallViewProps {
  call: ToolCallSegment & { result: NonNullable<ToolCallSegment['result']> };
}

function getToolCallTitle(name: string, input: unknown): string {
  const args: Record<string, unknown> = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
  return formatToolCallTitle({ id: '', name, arguments: args } satisfies ToolCall);
}

export function FinalToolCallView({ call }: FinalToolCallViewProps) {
  const title = useMemo(
    () => getToolCallTitle(call.name, call.input),
    [call.name, call.input],
  );

  const summary = useMemo(
    () => {
      if (call.result.kind !== 'ok') return null;
      return smartSummarize(call.name, call.input as Record<string, unknown>, call.result.content);
    },
    [call.name, call.input, call.result],
  );

  const isError = call.result.kind === 'error';
  const prefixColor = isError ? 'red' : 'gray';

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={prefixColor}>●</Text>
        <Text color="cyan"> {title}</Text>
        <Text color="gray"> {call.result.durationMs}ms</Text>
      </Box>
      {renderResult(call.result, summary)}
    </Box>
  );
}

function renderResult(result: ToolCallResult, summary: string | null) {
  if (summary) {
    return (
      <Box paddingLeft={2}>
        <Text color="gray">{summary}</Text>
      </Box>
    );
  }
  if (result.kind === 'ok' && result.content) {
    return (
      <Box paddingLeft={2}>
        <Text color="gray">{truncate(result.content, RESULT_TRUNCATION)}</Text>
      </Box>
    );
  }
  if (result.kind === 'error') {
    return (
      <Box paddingLeft={2}>
        <Text color="red">{truncate(result.message, RESULT_TRUNCATION)}</Text>
      </Box>
    );
  }
  return null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}
