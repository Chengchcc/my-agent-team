import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import type { Table, TableRow, TableCell, PhrasingContent } from 'mdast';
import type { RenderContext } from './render-ast';

function flattenText(nodes: PhrasingContent[]): string {
  return nodes.map(n => {
    if (n.type === 'text') return n.value;
    if (n.type === 'inlineCode') return n.value;
    if ('children' in n && Array.isArray(n.children)) {
      return flattenText(n.children as PhrasingContent[]);
    }
    return '';
  }).join('');
}

function normalize(rows: string[][], colCount: number): string[][] {
  return rows.map(row => {
    if (row.length >= colCount) return row.slice(0, colCount);
    return [...row, ...Array.from({ length: colCount - row.length }, () => '')];
  });
}

function calcColWidths(headers: string[], bodies: string[][]): number[] {
  const colCount = headers.length;
  return Array.from({ length: colCount }, (_, j) =>
    Math.max(
      stringWidth(headers[j] ?? ''),
      ...bodies.map(r => stringWidth(r[j] ?? '')),
    ),
  );
}

function padCell(text: string, width: number, align: string | null): string {
  const dw = stringWidth(text);
  if (dw >= width) return text;
  const pad = width - dw;
  if (align === 'right') return ' '.repeat(pad) + text;
  if (align === 'center') {
    const left = Math.floor(pad / 2);
    return ' '.repeat(left) + text + ' '.repeat(pad - left);
  }
  return text + ' '.repeat(pad);
}

interface TableViewProps {
  node: Table;
  ctx: RenderContext;
}

export function TableView({ node, ctx }: TableViewProps) {
  const [headerRow, ...bodyRows] = node.children;
  if (!headerRow) return null;

  const headers = headerRow.children.map((cell: TableCell) => flattenText(cell.children));
  const rawBodies = bodyRows.map((row: TableRow) =>
    row.children.map((cell: TableCell) => flattenText(cell.children)),
  );
  const colCount = headers.length;
  const bodies = normalize(rawBodies, colCount);
  const aligns: (string | null)[] = (node.align ?? []).map(a => a ?? null);

  const colWidths = calcColWidths(headers, bodies);
  const gutter = 3; // " │ " between columns
  const totalWidth = colWidths.reduce((a, b) => a + b, 0) + gutter * (colCount - 1);

  if (totalWidth > ctx.terminalWidth - 4) {
    return renderCompactTable(headers, bodies, colWidths, aligns);
  }

  return renderBoxTable(headers, bodies, colWidths, aligns);
}

function renderBoxTable(
  headers: string[],
  bodies: string[][],
  colWidths: number[],
  aligns: (string | null)[],
) {
  const pad = (text: string, j: number) => padCell(text, colWidths[j] ?? 0, aligns[j] ?? null);

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {colWidths.map(w => '─'.repeat(w)).join('─┬─')}
      </Text>
      <Text bold>
        {headers.map((h, j) => pad(h, j)).join(' │ ')}
      </Text>
      <Text dimColor>
        {colWidths.map(w => '─'.repeat(w)).join('─┼─')}
      </Text>
      {bodies.map((row, i) => (
        <Text key={i}>
          {row.map((cell, j) => pad(cell, j)).join(' │ ')}
        </Text>
      ))}
      <Text dimColor>
        {colWidths.map(w => '─'.repeat(w)).join('─┴─')}
      </Text>
    </Box>
  );
}

function renderCompactTable(
  headers: string[],
  bodies: string[][],
  _colWidths: number[],
  aligns: (string | null)[],
) {
  return (
    <Box flexDirection="column">
      {bodies.map((row, ri) => (
        <Box key={ri} flexDirection="column">
          {ri > 0 && (
            <Text dimColor>{'─'.repeat(40)}</Text>
          )}
          {row.map((cell, ci) => {
            const header = headers[ci] ?? '';
            const align = aligns[ci] ?? null;
            const alignedCell = padCell(cell, Math.max(stringWidth(header), stringWidth(cell)), align);
            return (
              <Text key={ci}>
                <Text bold>{padCell(header, Math.max(...headers.map(h => stringWidth(h))), null)}</Text>
                {' │ '}
                <Text>{alignedCell}</Text>
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
