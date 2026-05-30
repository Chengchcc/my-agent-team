import React from 'react';
import { Box, Text } from 'ink';

interface ToolInputPreviewProps {
  toolName: string;
  input: unknown;
}

const MAX_PREVIEW_LINES = 30;
const MAX_LINE_LENGTH = 200;
const WRITE_PREVIEW_LINES = 20;

function formatPreview(input: unknown): { label: string; content: string[] } {
  const obj = input as Record<string, unknown> | undefined;
  if (!obj) return { label: '', content: [] };

  const raw = JSON.stringify(input, null, 2);
  const lines = raw.split('\n').slice(0, MAX_PREVIEW_LINES);
  if (raw.split('\n').length > MAX_PREVIEW_LINES) {
    lines.push('...');
  }
  return { label: '', content: lines };
}

export function ToolInputPreview({ toolName, input }: ToolInputPreviewProps) {
  if (input == null) return null;
  const obj = input as Record<string, unknown> | undefined;
  if (!obj) return null;

  if (toolName === 'edit') {
    const path = String(obj.path ?? '');
    const oldStr = String(obj.old_string ?? '');
    const newStr = String(obj.new_string ?? '');
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Edit: {path}</Text>
        {oldStr && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Replace:</Text>
            <Text color="red">{truncateLine(oldStr, MAX_LINE_LENGTH)}</Text>
            <Text dimColor>With:</Text>
            <Text color="green">{truncateLine(newStr, MAX_LINE_LENGTH)}</Text>
          </Box>
        )}
      </Box>
    );
  }

  if (toolName === 'write') {
    const path = String(obj.path ?? '');
    const content = String(obj.content ?? '');
    const lines = content.split('\n');
    const preview = lines.slice(0, WRITE_PREVIEW_LINES);
    const more = lines.length > WRITE_PREVIEW_LINES ? `\n[+${lines.length - WRITE_PREVIEW_LINES} more lines]` : '';
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Write: {path}</Text>
        <Box flexDirection="column" marginTop={1}>
          {preview.map((line, i) => (
            <Text key={i} dimColor>{truncateLine(line, MAX_LINE_LENGTH)}</Text>
          ))}
          {more ? <Text dimColor>{more}</Text> : null}
        </Box>
      </Box>
    );
  }

  if (toolName === 'bash') {
    const command = String(obj.command ?? '');
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Command:</Text>
        <Text>$ {truncateLine(command, 120)}</Text>
      </Box>
    );
  }

  const { content } = formatPreview(input);
  if (content.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>Input:</Text>
      {content.map((line, i) => (
        <Text key={i} dimColor>{truncateLine(line, MAX_LINE_LENGTH)}</Text>
      ))}
    </Box>
  );
}

function truncateLine(line: string, max: number): string {
  if (line.length <= max) return line;
  return line.slice(0, max - 1) + '\u2026';
}
