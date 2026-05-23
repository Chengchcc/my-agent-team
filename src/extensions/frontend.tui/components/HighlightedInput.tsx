import { Box, Text } from 'ink';
import React from 'react';

const MAX_VISIBLE_CHARS = 200;
const WINDOW_PADDING = 40;

export function HighlightedInput({
  value,
  cursorOffset,
  placeholder,
  highlightedCommandName,
}: {
  value: string;
  cursorOffset: number;
  placeholder: string;
  highlightedCommandName?: string | null;
}) {
  if (value.length === 0) {
    return (
      <Box width="100%">
        <Text>
          {placeholder.length > 0 && (
            <>
              <Text inverse dimColor>
                {placeholder[0] ?? ' '}
              </Text>
              <Text dimColor>{placeholder.slice(1)}</Text>
            </>
          )}
        </Text>
      </Box>
    );
  }

  const highlightLength = highlightedCommandName ? highlightedCommandName.length + 1 : 0;
  const codePoints = Array.from(value);
  const lines = value.split('\n');
  const lineChars = lines.map((l) => Array.from(l));

  // Build code-point to code-unit offset map for cursor positioning
  const cpToUnit: number[] = [];
  let unit = 0;
  for (const cp of codePoints) {
    cpToUnit.push(unit);
    unit += cp.length;
  }

  // Find cursor code-point index
  const cursorCpIdx = cpToUnit.findIndex((u) => u >= cursorOffset);
  const totalCp = codePoints.length;

  // Window for very long input
  const windowed = totalCp > MAX_VISIBLE_CHARS;
  const visStart = windowed ? Math.max(0, Math.min(cursorCpIdx - WINDOW_PADDING, totalCp - MAX_VISIBLE_CHARS)) : 0;
  const visEnd = windowed ? Math.min(totalCp, visStart + MAX_VISIBLE_CHARS) : totalCp;

  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
      {windowed && visStart > 0 ? (
        <Text dimColor>← {visStart} chars omitted</Text>
      ) : null}
      {lineChars.map((chars, lineIdx) => {
        // Compute cumulative code-point offset at line start
        let lineCpStart = 0;
        for (let j = 0; j < lineIdx; j++) lineCpStart += lineChars[j]!.length + 1; // +1 for \n

        const lineCpEnd = lineCpStart + chars.length;
        // Skip lines entirely outside the window
        if (lineCpEnd <= visStart || lineCpStart >= visEnd) return null;

        const lineUnitEnd = cpToUnit[lineCpEnd] ?? unit;

        return (
          <Box key={lineIdx} flexDirection="row">
            {chars.length === 0 && cursorOffset >= (cpToUnit[lineCpStart] ?? 0) && cursorOffset <= (cpToUnit[lineCpStart] ?? 0) ? (
              <Text inverse> </Text>
            ) : null}
            {chars.map((char, charIdx) => {
              const globalCpIdx = lineCpStart + charIdx;
              if (globalCpIdx < visStart || globalCpIdx >= visEnd) return null;
              const charUnit = cpToUnit[globalCpIdx] ?? unit;
              const isCursor = charUnit === cursorOffset;
              const highlighted = charUnit < highlightLength;
              return (
                <Text
                  key={`${lineIdx}-${charIdx}`}
                  bold={highlighted}
                  {...(highlighted ? { color: 'cyan' } : {})}
                  inverse={isCursor}
                >
                  {isCursor && char === ' ' ? ' ' : char}
                </Text>
              );
            })}
            {cursorOffset === lineUnitEnd && cursorOffset >= (cpToUnit[lineCpStart] ?? 0) ? (
              <Text inverse> </Text>
            ) : null}
          </Box>
        );
      })}
      {windowed && visEnd < totalCp ? (
        <Text dimColor>→ {totalCp - visEnd} chars omitted</Text>
      ) : null}
    </Box>
  );
}
