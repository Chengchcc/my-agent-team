import React from 'react';
import { Box, Text } from 'ink';
import type { RootContent, PhrasingContent, Definition, FootnoteDefinition } from 'mdast';
import type { Block } from './parse-ast';
import { CodeBlock } from '../components/CodeBlock';
import { TableView } from './render-table';

export interface RenderContext {
  depth?: number;
  listOrdered?: boolean;
  listStart?: number;
  listItemIndex?: number;
  terminalWidth: number;
  definitions: Map<string, Definition>;
  footnotes: Map<string, FootnoteDefinition>;
}

// ── Block-level dispatcher ──

export function renderNode(node: RootContent, ctx: RenderContext): React.ReactNode {
  switch (node.type) {
    case 'heading':       return <HeadingView node={node} ctx={ctx} />;
    case 'paragraph':     return <ParagraphView node={node} ctx={ctx} />;
    case 'code':          return <CodeView node={node} />;
    case 'list':          return <ListView node={node} ctx={ctx} />;
    case 'listItem':      return <ListItemView node={node} ctx={ctx} />;
    case 'blockquote':    return <BlockquoteView node={node} ctx={ctx} />;
    case 'thematicBreak': return <ThematicBreakView ctx={ctx} />;
    case 'table':         return <TableView node={node} ctx={ctx} />;
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

function HeadingView({ node, ctx }: { node: import('mdast').Heading; ctx: RenderContext }) {
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

function ParagraphView({ node, ctx }: { node: import('mdast').Paragraph; ctx: RenderContext }) {
  return (
    <Text>
      {renderInline(node.children, ctx)}
    </Text>
  );
}

// ── Code block ──

function CodeView({ node }: { node: import('mdast').Code }) {
  return (
    <CodeBlock
      code={node.value}
      {...(node.lang ? { language: node.lang } : {})}
    />
  );
}

// ── Thematic break ──

function ThematicBreakView({ ctx }: { ctx: RenderContext }) {
  const width = Math.max(10, ctx.terminalWidth - 4);
  return <Text dimColor>{'\u2500'.repeat(width)}</Text>;
}

// ── Blockquote ──

function BlockquoteView({ node, ctx }: { node: import('mdast').Blockquote; ctx: RenderContext }) {
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

function ListView({ node, ctx }: { node: import('mdast').List; ctx: RenderContext }) {
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

function ListItemView({ node, ctx }: { node: import('mdast').ListItem; ctx: RenderContext }) {
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
        {renderInline((node.children[0] as import('mdast').Paragraph).children, ctx)}
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
      <Text dimColor>{'\u2500'.repeat(Math.max(10, ctx.terminalWidth - 4))}</Text>
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
      stable.push(
        <Box key={block.id}>
          {renderNode(block.node, ctx)}
        </Box>,
      );
    } else if (block.startOffset < committedLength) {
      // Straddling commit boundary — only happens if micromark offset ≠ mdast offset.
      // Render entirely as tail to prevent the uncommitted portion from appearing twice
      // (once formatted in stable, once raw in tail).
      const trimmed = block.raw.replace(/\n+$/, '');
      if (trimmed) {
        tail.push(<Text key={`tail-${block.id}`}>{trimmed}</Text>);
      }
    } else {
      // Entirely uncommitted
      const trimmed = block.raw.replace(/\n+$/, '');
      if (trimmed) {
        tail.push(<Text key={`tail-${block.id}`}>{trimmed}</Text>);
      }
    }
  }

  return { stable, tail };
}
