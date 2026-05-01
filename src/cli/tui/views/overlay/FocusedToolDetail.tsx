import React from 'react';
import { Box, Text } from 'ink';
import { useInteractionSelector } from '../../state/selectors';
import type { FinalItem, ActiveState, ActiveToolCall, ToolCallSegment } from '../../state/types';

interface FocusedToolDetailProps {
  finalizedItems: FinalItem[];
  active: ActiveState;
}

type CallInfo = { name: string; result: { kind: string; content?: string; message?: string } | null };

export function FocusedToolDetail({ finalizedItems, active }: FocusedToolDetailProps) {
  const focusedId = useInteractionSelector(s => s.focusedToolId);
  if (!focusedId) return null;

  // Search active first, then the most recent finalized assistant message
  let call: CallInfo | null = findInActive(active, focusedId);
  if (!call) call = findInLastFinalized(finalizedItems, focusedId);
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

function findInActive(active: ActiveState, id: string): CallInfo | null {
  const seg = active.streamingAssistant?.segments.find(
    (s): s is ActiveToolCall => s.kind === 'tool_call' && s.id === id,
  );
  if (!seg) return null;
  return { name: seg.name, result: seg.result };
}

function findInLastFinalized(items: FinalItem[], id: string): CallInfo | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === 'assistant-message') {
      const seg = item.segments.find(
        (s): s is ToolCallSegment => s.kind === 'tool_call' && s.id === id,
      );
      if (seg) return { name: seg.name, result: seg.result };
      break;
    }
  }
  return null;
}
