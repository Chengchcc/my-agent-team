import { Box, Text } from "ink";
import React from 'react';
import type { SessionPickerSession } from '../state/types';

const MAX_VISIBLE_SESSIONS = 5;
const ID_PREFIX_LENGTH = 8;
const PREVIEW_MAX_LENGTH = 60;
const ELLIPSIS_LENGTH = 3;

interface SessionPickerProps {
  sessions: SessionPickerSession[];
  selectedIndex: number;
}

export function SessionPicker({ sessions, selectedIndex }: SessionPickerProps) {
  if (sessions.length === 0) {
    return (
      <Box paddingX={2} borderStyle="single" borderColor="yellow">
        <Text dimColor>No saved sessions found.</Text>
      </Box>
    );
  }

  const { startIndex, endIndex } = getVisibleWindow(sessions.length, selectedIndex, MAX_VISIBLE_SESSIONS);
  const visibleSessions = sessions.slice(startIndex, endIndex);
  const shown = endIndex - startIndex;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
      <Box>
        <Text bold color="yellow">
          Sessions ({sessions.length} total, newest first)
        </Text>
      </Box>

      {startIndex > 0 && (
        <Box paddingX={2}>
          <Text dimColor>↑ {startIndex} more above</Text>
        </Box>
      )}

      {visibleSessions.map((session, visibleIndex) => {
        const index = startIndex + visibleIndex;
        const isSelected = index === selectedIndex;
        const shortId = session.id.slice(0, ID_PREFIX_LENGTH);
        const date = new Date(session.updatedAt).toLocaleString();
        const preview = session.lastUserMessage
          ? truncate(session.lastUserMessage, PREVIEW_MAX_LENGTH)
          : '(empty)';

        return (
          <Box key={session.id} flexDirection="column" paddingX={1}>
            <Box flexDirection="row">
              <Text {...(isSelected ? { color: 'cyan' } : {})} bold={isSelected}>
                {isSelected ? '❯ ' : '  '}
                {String(index + 1)}.
              </Text>
              <Text {...(isSelected ? { color: 'cyan' } : {})} bold={isSelected}>
                {' '}{shortId}
              </Text>
              <Text dimColor> — {date}</Text>
              <Text dimColor> ({session.messageCount} msgs)</Text>
            </Box>
            <Box paddingLeft={4}>
              <Text {...(isSelected ? { color: 'cyan' } : { dimColor: true })}>
                {preview}
              </Text>
            </Box>
          </Box>
        );
      })}

      {shown < sessions.length - startIndex && (
        <Box paddingX={2}>
          <Text dimColor>↓ {endIndex < sessions.length ? `${sessions.length - endIndex} more below` : ''}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>↑↓ select  ·  Enter resume  ·  Esc cancel</Text>
      </Box>
    </Box>
  );
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - ELLIPSIS_LENGTH)}...`;
}

function getVisibleWindow(total: number, selectedIndex: number, maxVisible: number) {
  if (total <= maxVisible) {
    return { startIndex: 0, endIndex: total };
  }

  const halfWindow = Math.floor(maxVisible / 2);
  const maxStartIndex = total - maxVisible;
  const startIndex = Math.max(0, Math.min(selectedIndex - halfWindow, maxStartIndex));

  return {
    startIndex,
    endIndex: startIndex + maxVisible,
  };
}
