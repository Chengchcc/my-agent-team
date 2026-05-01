import React from 'react';
import { Box, Text } from 'ink';
import { useTuiStore } from '../../state/store';
import type { FinalItem, ToolCallSegment } from '../../state/types';

interface FocusedToolDetailProps {
  finalizedItems: FinalItem[];
}

type CallInfo = { name: string; result: { kind: string; content?: string; message?: string } | null };

export function FocusedToolDetail({ finalizedItems }: FocusedToolDetailProps) {
  const focusedId = useTuiStore(s => s.interaction.focusedToolId);
  if (!focusedId) return null;

  // Search all finalized items (including streaming) — newest first
  let call: CallInfo | null = null;
  for (let i = finalizedItems.length - 1; i >= 0; i--) {
    const item = finalizedItems[i]!;
    if (item.kind === 'assistant-message') {
      const seg = item.segments.find(
        (s): s is ToolCallSegment => s.kind === 'tool_call' && s.id === focusedId,
      );
      if (seg) { call = { name: seg.name, result: seg.result }; break; }
    }
  }
  if (!call) return null;

  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1} marginY={1}>
      <Text bold color="cyan">{call.name}</Text>
      <Box marginTop={1}>
        <Text dimColor>Result: </Text>
        <Text>{call.result?.content ?? call.result?.message ?? '…'}</Text>
      </Box>
    </Box>
  );
}
