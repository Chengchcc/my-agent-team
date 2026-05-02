import React from 'react';
import { Box, Text } from 'ink';
import { parseDoc } from '../markdown/parse-ast';
import { renderNode, FootnotesSection, type RenderContext } from '../markdown/render-ast';

const DEFAULT_TERMINAL_WIDTH = 80;

/**
 * Render markdown content to React elements using mdast AST parsing.
 * For the final (Static) rendering path where all content is committed.
 */
export function renderMarkdownTokens(content: string): React.ReactNode[] {
  if (!content) return [];

  const { blocks, definitions, footnotes } = parseDoc(content);
  if (blocks.length === 0) {
    return [<Text key="raw">{content}</Text>];
  }

  const ctx: RenderContext = {
    terminalWidth: process.stdout.columns || DEFAULT_TERMINAL_WIDTH,
    definitions,
    footnotes,
  };
  const elements = blocks.map(block => (
    <Box key={block.id}>
      {renderNode(block.node, ctx)}
    </Box>
  ));

  // Append footnotes section at end of document
  const footnoteSection = FootnotesSection({ footnotes, ctx });
  if (footnoteSection) {
    elements.push(<Box key="footnotes-section">{footnoteSection}</Box>);
  }

  return elements;
}

// Re-export for callers that depended on the old signature
export { renderMarkdownTokens as renderMarkdownCached };
