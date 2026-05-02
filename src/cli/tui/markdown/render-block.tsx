import React from 'react';
import { Box, Text } from 'ink';
import { CodeBlock } from '../components/CodeBlock';
import type { Block } from './parse-blocks';

// ── Inline parser ──

interface InlineToken {
  type: 'text' | 'bold' | 'italic' | 'code' | 'link' | 'image' | 'strikethrough' | 'linebreak';
  content: string;
  url?: string;
  alt?: string;
}

// Regex group indices — must match the alternation order in the regex below
const enum RG {
  INLINE_CODE = 1,
  BOLD_STAR = 3,
  ITALIC_STAR = 5,
  BOLD_UNDER = 7,
  ITALIC_UNDER = 9,
  STRIKE = 11,
  IMAGE = 12,
  IMAGE_ALT = 13,
  IMAGE_URL = 14,
  LINK = 15,
  LINK_TEXT = 16,
  LINK_URL = 17,
  ESCAPED_NEWLINE = 18,
  NEWLINE = 19,
}

function parseInline(raw: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  // Match order matters — longer patterns first
  const re = /(`[^`]+`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(__([^_]+)__)|(_([^_]+)_)|(~~([^~]+)~~)|(!\[([^\]]*)\]\(([^)]+)\))|(\[([^\]]*)\]\(([^)]+)\))|(\\\n?)|(\n)/g;
  let lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    // Emit any preceding plain text
    if (m.index > lastIndex) {
      tokens.push({ type: 'text', content: raw.slice(lastIndex, m.index) });
    }

    if (m[RG.INLINE_CODE]) {
      const code = m[RG.INLINE_CODE]!.slice(1, -1); // strip backticks
      tokens.push({ type: 'code', content: code });
    } else if (m[RG.BOLD_STAR]) {
      tokens.push({ type: 'bold', content: m[RG.BOLD_STAR]! });
    } else if (m[RG.ITALIC_STAR]) {
      tokens.push({ type: 'italic', content: m[RG.ITALIC_STAR]! });
    } else if (m[RG.BOLD_UNDER]) {
      tokens.push({ type: 'bold', content: m[RG.BOLD_UNDER]! });
    } else if (m[RG.ITALIC_UNDER]) {
      tokens.push({ type: 'italic', content: m[RG.ITALIC_UNDER]! });
    } else if (m[RG.STRIKE]) {
      tokens.push({ type: 'strikethrough', content: m[RG.STRIKE]! });
    } else if (m[RG.IMAGE]) {
      tokens.push({ type: 'image', content: '', alt: m[RG.IMAGE_ALT] ?? '', url: m[RG.IMAGE_URL] ?? '' });
    } else if (m[RG.LINK]) {
      tokens.push({ type: 'link', content: m[RG.LINK_TEXT] ?? '', url: m[RG.LINK_URL] ?? '' });
    } else if (m[RG.ESCAPED_NEWLINE]) {
      tokens.push({ type: 'linebreak', content: '\n' });
    } else if (m[RG.NEWLINE]) {
      tokens.push({ type: 'text', content: ' ' });
    }

    lastIndex = m.index + m[0].length;
  }

  // Trailing text
  if (lastIndex < raw.length) {
    tokens.push({ type: 'text', content: raw.slice(lastIndex) });
  }

  return tokens;
}

// ── Inline renderer ──

function renderInline(tokens: InlineToken[]): React.ReactNode[] {
  return tokens.map((t, i) => {
    switch (t.type) {
      case 'text':
        return <Text key={i}>{t.content}</Text>;
      case 'bold':
        return <Text key={i} bold>{t.content}</Text>;
      case 'italic':
        return <Text key={i} italic>{t.content}</Text>;
      case 'code':
        return <Text key={i} backgroundColor="#2d2d2d">{t.content}</Text>;
      case 'link':
        return (
          <Text key={i} dimColor>
            {t.content}
            {t.url && !t.content.includes(t.url) ? ` (${t.url})` : ''}
          </Text>
        );
      case 'image':
        return (
          <Text key={i} dimColor>
            [image{t.alt ? `: ${t.alt}` : ''}]
          </Text>
        );
      case 'strikethrough':
        return <Text key={i} strikethrough>{t.content}</Text>;
      case 'linebreak':
        return <Text key={i}>{'\n'}</Text>;
    }
  });
}

// ── Table parser ──

interface ParsedTable {
  headers: string[];
  alignments: Array<'left' | 'center' | 'right'>;
  rows: string[][];
}

function parseTable(raw: string): ParsedTable | null {
  const lines = raw.trim().split('\n');
  if (lines.length < 2) return null;

  const parseRow = (line: string): string[] =>
    line.replace(/^\|?\s*/, '').replace(/\s*\|?\s*$/, '').split('|').map(c => c.trim());

  const headers = parseRow(lines[0]!);
  const delims  = parseRow(lines[1]!);
  const rows    = lines.slice(2).map(parseRow);

  // Validate: delimiter row should contain only dashes and optional colons
  if (delims.length === 0 || !delims.every(d => /^:?-+:?$/.test(d))) return null;

  const alignments: Array<'left' | 'center' | 'right'> = delims.map(d => {
    const l = d.startsWith(':');
    const r = d.endsWith(':');
    if (l && r) return 'center';
    if (r) return 'right';
    return 'left';
  });

  return { headers, alignments, rows };
}

// ── Block renderer ──

export function renderBlock(block: Block): React.ReactNode {
  switch (block.type) {

    // ── Heading ──
    case 'heading': {
      const level = block.level ?? 1;
      let content = block.raw.replace(/\n+$/, '');
      // Strip atx markers
      content = content.replace(/^#{1,6}\s+/, '');
      // Strip setext underline
      content = content.replace(/\n[=\-]+$/, '');
      const tokens = parseInline(content);
      // H1 cyan+bold, H2 cyan, H3+ default+bold
      const color = level <= 2 ? 'cyan' : undefined;
      const bold = level <= 3;
      return (
        <Text key={block.id} bold={bold} {...(color ? { color } : {})}>
          {renderInline(tokens)}
        </Text>
      );
    }

    // ── Code blocks ──
    case 'codeFenced':
    case 'codeIndented': {
      let code: string;
      if (block.type === 'codeFenced') {
        code = block.raw
          .replace(/^[`~]{3,}[^\n]*\n/, '')
          .replace(/\n[`~]{3,}\s*$/, '');
      } else {
        code = block.raw.replace(/^( {4}|\t)/gm, '');
      }
      return (
        <CodeBlock
          key={block.id}
          code={code.trimEnd()}
          {...(block.info != null ? { language: block.info } : {})}
        />
      );
    }

    // ── Paragraph ──
    case 'paragraph': {
      const tokens = parseInline(block.raw.replace(/\n+$/, ''));
      return (
        <Text key={block.id}>
          {renderInline(tokens)}
        </Text>
      );
    }

    // ── List item ──
    case 'listItem': {
      const isOrdered = block.listKind === 'ordered';
      const prefix = isOrdered
        ? `  ${block.itemIndex ?? 1}. `
        : '  \u2022 ';
      const inner = block.raw
        .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
        .replace(/\n+$/, '');
      const tokens = parseInline(inner);
      return (
        <Text key={block.id}>
          <Text color="cyan">{prefix}</Text>
          {renderInline(tokens)}
        </Text>
      );
    }

    // ── Blockquote ──
    case 'blockquote': {
      const inner = block.raw
        .split('\n')
        .map(line => line.replace(/^>\s?/, ''))
        .join('\n')
        .replace(/\n+$/, '');
      // Prefix every line with a vertical bar for visual border
      const bordered = '\u2502 ' + inner.replace(/\n/g, '\n\u2502 ');
      const tokens = parseInline(bordered);
      return (
        <Text key={block.id} dimColor>
          {renderInline(tokens)}
        </Text>
      );
    }

    // ── Thematic break ──
    case 'thematicBreak': {
      const width = process.stdout.columns || 80;
      return <Text key={block.id} dimColor>{'\u2500'.repeat(width)}</Text>;
    }

    // ── Table ──
    case 'table': {
      const parsed = parseTable(block.raw);
      if (!parsed) {
        return <Text key={block.id}>{block.raw}</Text>;
      }
      const { headers, alignments, rows } = parsed;
      const allRows = [headers, ...rows];
      const colWidths: number[] = headers.map((_, ci) =>
        Math.max(...allRows.map(r => (r[ci] ?? '').length)),
      );

      const padCell = (text: string, w: number, a: 'left' | 'center' | 'right'): string => {
        if (a === 'right')  return text.padStart(w);
        if (a === 'center') {
          const pad = w - text.length;
          const left = Math.floor(pad / 2);
          return ' '.repeat(left) + text + ' '.repeat(pad - left);
        }
        return text.padEnd(w);
      };

      const renderRow = (cells: string[]): string =>
        '\u2502 ' +
        cells.map((c, ci) => padCell(c, colWidths[ci] ?? 0, alignments[ci] ?? 'left')).join(' \u2502 ') +
        ' \u2502';

      const headerLine = renderRow(headers);
      const sepLine = '\u251c' + colWidths.map(w => '\u2500'.repeat(w + 2)).join('\u253c') + '\u2524';
      const bodyLines = rows.map(renderRow);

      return <Text key={block.id}>{[headerLine, sepLine, ...bodyLines].join('\n')}</Text>;
    }

    // ── HTML flow (strip tags) ──
    case 'htmlFlow': {
      const stripped = block.raw.replace(/<[^>]*>/g, '').trim();
      if (!stripped) {
        return <React.Fragment key={block.id} />;
      }
      return <Text key={block.id}>{stripped}</Text>;
    }

    // ── Definition / Other (skip rendering) ──
    case 'definition':
    case 'other':
      return <React.Fragment key={block.id} />;

    default:
      return <React.Fragment key={block.id} />;
  }
}

// ── Batch renderer ──

export function renderBlocks(
  blocks: Block[],
  committedLength: number,
): { stable: React.ReactNode[]; tail: React.ReactNode[] } {
  const stable: React.ReactNode[] = [];
  const tail: React.ReactNode[] = [];

  for (const block of blocks) {
    if (block.endOffset <= committedLength) {
      stable.push(<Box key={block.id}>{renderBlock(block)}</Box>);
    } else if (block.startOffset < committedLength) {
      stable.push(<Box key={block.id}>{renderBlock(block)}</Box>);
      const remaining = block.raw.slice(committedLength - block.startOffset).replace(/\n+$/, '');
      if (remaining) {
        tail.push(<Text key={`tail-${block.id}`}>{remaining}</Text>);
      }
    } else {
      const trimmed = block.raw.replace(/\n+$/, '');
      if (trimmed) {
        tail.push(<Text key={`tail-${block.id}`}>{trimmed}</Text>);
      }
    }
  }

  return { stable, tail };
}
