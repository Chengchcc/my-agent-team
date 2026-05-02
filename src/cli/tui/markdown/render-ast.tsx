import React from 'react';
import { Box, Text } from 'ink';
import type { RootContent, PhrasingContent, Definition, FootnoteDefinition, Heading, Paragraph, Code, Blockquote, Table, TableCell, List, ListItem } from 'mdast';
import type { Block } from './parse-ast';
import { CodeBlock } from '../components/CodeBlock';
import { TableView } from './render-table';

const MIN_RULE_WIDTH = 10;
const RULE_MARGIN = 4;

export interface RenderContext {
  depth?: number;
  listOrdered?: boolean;
  listStart?: number;
  listItemIndex?: number;
  terminalWidth: number;
  definitions: Map<string, Definition>;
  footnotes: Map<string, FootnoteDefinition>;
  streaming?: boolean;
}

// ── Block-level dispatcher ──

export function renderNode(node: RootContent, ctx: RenderContext): React.ReactNode {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (node.type) {
    case 'heading':       return <HeadingView node={node} ctx={ctx} />;
    case 'paragraph':     return <ParagraphView node={node} ctx={ctx} />;
    case 'code':          return ctx.streaming ? <CodeStreamingView node={node} /> : <CodeView node={node} />;
    case 'list':          return <ListView node={node} ctx={ctx} />;
    case 'listItem':      return <ListItemView node={node} ctx={ctx} />;
    case 'blockquote':    return <BlockquoteView node={node} ctx={ctx} />;
    case 'thematicBreak': return ctx.streaming ? null : <ThematicBreakView ctx={ctx} />;
    case 'table':         return ctx.streaming ? <TableStreamingView node={node} /> : <TableView node={node} ctx={ctx} />;
    case 'html':          return null;
    default:              return null;
  }
}

// ── Inline (phrasing) dispatcher ──

function renderInline(
  children: PhrasingContent[],
  ctx: RenderContext,
): React.ReactNode {
  return children.map((n, i) => (
    <InlineNode key={i} node={n} ctx={ctx} />
  ));
}

function InlineNode({ node, ctx }: { node: PhrasingContent; ctx: RenderContext }): React.ReactElement | null {
  switch (node.type) {
    case 'text':
      return <Text>{node.value}</Text>;
    case 'strong':
      return <Text bold>{renderInline(node.children, ctx)}</Text>;
    case 'emphasis':
      return <Text italic>{renderInline(node.children, ctx)}</Text>;
    case 'delete':
      return <Text strikethrough>{renderInline(node.children, ctx)}</Text>;
    case 'inlineCode':
      return <Text backgroundColor="#2d2d2d">{node.value}</Text>;
    case 'link':
      return (
        <Text dimColor>
          {renderInline(node.children, ctx)}
          {node.url ? ` (${node.url})` : ''}
        </Text>
      );
    case 'linkReference': {
      const def = ctx.definitions.get(node.identifier);
      if (!def) {
        return (
          <Text dimColor>
            {renderInline(node.children, ctx)}
          </Text>
        );
      }
      return (
        <Text dimColor>
          {renderInline(node.children, ctx)}
          {` (${def.url})`}
        </Text>
      );
    }
    case 'imageReference': {
      const def = ctx.definitions.get(node.identifier);
      return <Text dimColor>[image{def ? ` (${def.url})` : ''}]</Text>;
    }
    case 'image':
      return <Text dimColor>[image{node.alt ? `: ${node.alt}` : ''}]</Text>;
    case 'break':
      return <Text>{'\n'}</Text>;
    case 'html':
      return null;
    case 'footnoteReference': {
      const order = [...ctx.footnotes.keys()].indexOf(node.identifier) + 1;
      return <Text color="cyan">[{order}]</Text>;
    }
    default:
      return null;
  }
}

// ── Heading ──

const HEADING_DECORATION: Record<number, { color: string; prefix: string }> = {
  1: { color: 'cyan', prefix: '\u2501 ' },
  2: { color: 'cyan', prefix: '\u2501\u2501 ' },
  3: { color: 'green', prefix: '### ' },
  4: { color: 'yellow', prefix: '#### ' },
  5: { color: 'magenta', prefix: '##### ' },
  6: { color: 'blue', prefix: '###### ' },
};

function HeadingView({ node, ctx }: { node: Heading; ctx: RenderContext }) {
  const deco = HEADING_DECORATION[node.depth] ?? { color: 'white', prefix: '' };
  const prefix = node.depth <= 2 ? deco.prefix : '';
  return (
    <Text bold color={deco.color}>
      {prefix}
      {renderInline(node.children, ctx)}
    </Text>
  );
}

// ── Paragraph ──

function ParagraphView({ node, ctx }: { node: Paragraph; ctx: RenderContext }) {
  return (
    <Text>
      {renderInline(node.children, ctx)}
    </Text>
  );
}

// ── Code block ──

function CodeView({ node }: { node: Code }) {
  return (
    <CodeBlock
      code={node.value}
      {...(node.lang ? { language: node.lang } : {})}
    />
  );
}

/** Streaming mode: code block may be incomplete (missing closing fence). Render as dim plain text. */
function CodeStreamingView({ node }: { node: Code }) {
  return <Text dimColor>{node.value}</Text>;
}

// ── Table (streaming fallback) ──

function TableStreamingView({ node }: { node: Table }) {
  // In streaming mode, flatten table to compact per-row text
  const rows = node.children.map((row, ri) => {
    if (row.type !== 'tableRow') return null;
    const cells = row.children
      .filter((c): c is TableCell => c.type === 'tableCell')
      .map(c => {
        // Extract plain text from cell's children
        const text = c.children
          .map(p => 'value' in p ? String((p as { value: unknown }).value) : '')
          .join('');
        return text;
      })
      .join(' | ');
    return <Text key={ri} dimColor>{ri === 0 ? `${cells}\n` : cells}</Text>;
  });
  return <Box flexDirection="column">{rows}</Box>;
}

// ── Thematic break ──

function ThematicBreakView({ ctx }: { ctx: RenderContext }) {
  const width = Math.max(MIN_RULE_WIDTH, ctx.terminalWidth - RULE_MARGIN);
  return <Text dimColor>{'\u2500'.repeat(width)}</Text>;
}

// ── Blockquote ──

function BlockquoteView({ node, ctx }: { node: Blockquote; ctx: RenderContext }) {
  return (
    <Box flexDirection="column">
      {node.children.map((child, i) => (
        <Box key={i}>
          <Text dimColor>{'\u2502 '}</Text>
          <Text dimColor>
            {renderNode(child as RootContent, { ...ctx, depth: (ctx.depth ?? 0) + 1 })}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

// ── List ──

function ListView({ node, ctx }: { node: List; ctx: RenderContext }) {
  return (
    <Box flexDirection="column">
      {node.children.map((item, i) => (
        <React.Fragment key={i}>
          {renderNode(item, {
            ...ctx,
            depth: (ctx.depth ?? 0) + 1,
            listOrdered: node.ordered === true,
            listStart: node.start ?? 1,
            listItemIndex: i,
          })}
        </React.Fragment>
      ))}
    </Box>
  );
}

// ── List item ──

function ListItemView({ node, ctx }: { node: ListItem; ctx: RenderContext }) {
  const indent = '  '.repeat(Math.max(0, (ctx.depth ?? 1) - 1));
  const marker = ctx.listOrdered
    ? `${(ctx.listStart ?? 1) + (ctx.listItemIndex ?? 0)}.`
    : '\u2022';

  // GFM task list checkbox
  const checked = node.checked;
  const checkbox = checked == null ? '' : checked ? '[\u2713] ' : '[ ] ';

  // Fast path: single paragraph item → one Text line
  if (node.children.length === 1 && node.children[0]?.type === 'paragraph') {
    return (
      <Text>
        {indent}
        <Text color="cyan">{marker}</Text>{' '}
        {checkbox}
        {renderInline((node.children[0] as Paragraph).children, ctx)}
      </Text>
    );
  }

  // Slow path: multi-block item content
  return (
    <Box>
      <Text>{indent}<Text color="cyan">{marker}</Text>{checkbox ? ` ${checkbox}` : ' '}</Text>
      <Box flexDirection="column">
        {node.children.map((child, i) => (
          <React.Fragment key={i}>{renderNode(child as RootContent, ctx)}</React.Fragment>
        ))}
      </Box>
    </Box>
  );
}


// ── Footnotes section ──

export function FootnotesSection({ footnotes, ctx }: { footnotes: Map<string, FootnoteDefinition>; ctx: RenderContext }) {
  if (footnotes.size === 0) return null;

  const entries = [...footnotes.entries()];
  return (
    <Box flexDirection="column">
      <Text dimColor>{'\u2500'.repeat(Math.max(MIN_RULE_WIDTH, ctx.terminalWidth - RULE_MARGIN))}</Text>
      {entries.map(([id, def], i) => (
        <Box key={id}>
          <Box width={4} flexShrink={0}>
            <Text color="cyan">[{i + 1}]</Text>
          </Box>
          <Box flexDirection="column">
            {def.children.map((child, j) => (
              <React.Fragment key={j}>{renderNode(child as RootContent, ctx)}</React.Fragment>
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

// ── Memoized block view ──

const BlockView = React.memo(
  function BlockView({ node, ctx }: { node: RootContent; ctx: RenderContext }) {
    return (
      <Box>
        {renderNode(node, ctx)}
      </Box>
    );
  },
  (prev, next) =>
    prev.node === next.node &&
    prev.ctx.terminalWidth === next.ctx.terminalWidth &&
    prev.ctx.definitions === next.ctx.definitions &&
    prev.ctx.footnotes === next.ctx.footnotes,
);

// ── Batch renderer ──

export function renderBlocks(
  blocks: Block[],
  committedLength: number,
  ctx: RenderContext,
): { stable: React.ReactNode[]; tail: React.ReactNode[] } {
  const stable: React.ReactNode[] = [];
  const tail: React.ReactNode[] = [];

  for (const block of blocks) {
    if (block.endOffset <= committedLength) {
      stable.push(<BlockView key={block.id} node={block.node} ctx={ctx} />);
    } else if (tail.length === 0) {
      // Plain-text tail: avoids expensive AST traversal during streaming.
      // Once committed, BlockView renders the full formatted AST.
      tail.push(
        <Text key={`tail-${block.id}`}>{block.raw.replace(/\n+$/, '')}</Text>,
      );
    }
  }

  return { stable, tail };
}
