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

const THEMATIC_BREAK_WIDTH = 40;

/**
 * Parse inline markdown within a single block (paragraph, heading, listItem).
 * Handles: **bold**, *italic*, `code`, [text](url), ![alt](url), ~~strikethrough~~.
 */
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

// ── Block renderer ──

export function renderBlock(block: Block): React.ReactNode {
  switch (block.type) {
    case 'heading':
      return <Text bold>{block.raw.replace(/^#+\s*/gm, '').replace(/\n+$/, '')}</Text>;

    case 'codeFenced':
    case 'codeIndented': {
      // Extract code content (strip opening/closing fences)
      let code: string;
      if (block.type === 'codeFenced') {
        const lines = block.raw.split('\n');
        // Remove fence lines
        const inner = lines.slice(1, lines.length - 1);
        code = inner.join('\n');
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

    case 'paragraph': {
      const tokens = parseInline(block.raw.replace(/\n+$/, ''));
      return (
        <React.Fragment key={block.id}>
          {renderInline(tokens)}
        </React.Fragment>
      );
    }

    case 'listItem': {
      const tokens = parseInline(block.raw.replace(/^\s*[-*+]\s+|^\s*\d+\.\s+/, '').replace(/\n+$/, ''));
      return (
        <React.Fragment key={block.id}>
          <Text>{'  '}</Text>
          {renderInline(tokens)}
        </React.Fragment>
      );
    }

    case 'blockquote': {
      const inner = block.raw
        .split('\n')
        .map(line => line.replace(/^>\s?/, ''))
        .join('\n')
        .replace(/\n+$/, '');
      return (
        <Text key={block.id} dimColor>
          {inner}
        </Text>
      );
    }

    case 'thematicBreak':
      return <Text key={block.id} dimColor>{'─'.repeat(THEMATIC_BREAK_WIDTH)}</Text>;

    case 'table':
    case 'list':
    case 'htmlFlow':
    case 'definition':
    case 'other':
      return <Text key={block.id}>{block.raw}</Text>;
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
