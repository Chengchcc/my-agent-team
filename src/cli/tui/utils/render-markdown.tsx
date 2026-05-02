import React from 'react';
import { Text } from 'ink';
import { parseToBlocks } from '../markdown/parse-blocks';
import { renderBlock } from '../markdown/render-block';

/**
 * Render markdown content to React elements using micromark block parsing.
 * For the final (Static) rendering path where all content is committed.
 */
export function renderMarkdownTokens(content: string): React.ReactNode[] {
  if (!content) return [];

  const blocks = parseToBlocks(content);
  if (blocks.length === 0) {
    return [<Text key="raw">{content}</Text>];
  }

  const elements: React.ReactNode[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    elements.push(<React.Fragment key={block.id}>{renderBlock(block)}</React.Fragment>);
    if (i < blocks.length - 1) {
      elements.push(<Text key={`sp-${i}`}>{'\n'}</Text>);
    }
  }
  return elements;
}

// Re-export for callers that depended on the old signature
export { renderMarkdownTokens as renderMarkdownCached };
