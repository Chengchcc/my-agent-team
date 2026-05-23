import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ToolCallResult } from '../../state/types';
import { formatToolCallTitle, smartSummarize } from '../../utils/tool-format';
import type { ToolCallShape } from '../../utils/tool-format';

const RESULT_TRUNCATION = 200;

interface ToolCallFinalViewProps {
  name: string;
  input: unknown;
  result: ToolCallResult;
  expanded: boolean;
}

function getToolCallTitle(name: string, input: unknown): string {
  const args: Record<string, unknown> = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
  return formatToolCallTitle({ id: '', name, arguments: args } satisfies ToolCallShape);
}

export const ToolCallFinalView = React.memo(function ToolCallFinalView({ name, input, result, expanded }: ToolCallFinalViewProps) {
  const title = useMemo(
    () => getToolCallTitle(name, input),
    [name, input],
  );

  const summary = useMemo(
    () => {
      if (result.kind !== 'ok') return null;
      return smartSummarize(name, input as Record<string, unknown>, result.content);
    },
    [name, input, result],
  );

  const isError = result.kind === 'error';
  const prefixColor = isError ? 'red' : 'gray';

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box>
        <Text color={prefixColor}>●</Text>
        <Text color="cyan"> {title}</Text>
        <Text color="gray"> {result.durationMs}ms</Text>
      </Box>
      {expanded ? renderExpanded(result) : renderCollapsed(result, summary)}
    </Box>
  );
});

function renderCollapsed(result: ToolCallResult, summary: string | null) {
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

function renderExpanded(result: ToolCallResult) {
  if (result.kind === 'ok' && result.content) {
    return (
      <Box paddingLeft={2} flexDirection="column">
        <Text dimColor>{result.content}</Text>
      </Box>
    );
  }
  if (result.kind === 'error') {
    return (
      <Box paddingLeft={2}>
        <Text color="red">{result.message}</Text>
      </Box>
    );
  }
  return null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}
