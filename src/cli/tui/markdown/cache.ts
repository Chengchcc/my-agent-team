import React from 'react';
import { Text } from 'ink';
import type { Definition, FootnoteDefinition } from 'mdast';
import type { Block } from './parse-ast';
import { renderBlocks, FootnotesSection, type RenderContext } from './render-ast';
import { debugLog } from '../../../utils/debug';

/**
 * Stateless rendering entry for streaming path.
 * Parsing happens in committer.buildSnapshot; blocks are passed via SegFrame.
 */
class MarkdownRenderer {
  render(
    content: string,
    committedLength: number,
    terminalWidth: number,
    blocks: Block[],
    definitions: Map<string, Definition>,
    footnotes: Map<string, FootnoteDefinition>,
  ): { stable: React.ReactNode[]; tail: React.ReactNode[] } {
    const ctx: RenderContext = { terminalWidth, definitions, footnotes };
    const result = renderBlocks(blocks, committedLength, ctx);

    debugLog('RENDER split', { total: blocks.length, stable: result.stable.length, tail: result.tail.length, committedLength, contentLen: content.length });

    // When no markdown blocks are detected (plain text), render trailing
    // content as raw text so it appears in the live TUI output.
    if (blocks.length === 0 && committedLength < content.length) {
      result.tail.push(React.createElement(Text, { key: 'raw-tail' }, content.slice(committedLength)));
    }

    // Append footnotes section to stable when fully committed
    if (committedLength >= content.length && footnotes.size > 0) {
      result.stable.push(
        React.createElement(
          React.Fragment,
          { key: 'footnotes-section' },
          FootnotesSection({ footnotes, ctx }),
        ),
      );
    }

    return result;
  }

  /** Reset is a no-op — renderer is stateless. Kept for API compatibility. */
  reset(): void {}
}

let instance: MarkdownRenderer | null = null;

export function getMarkdownRenderer(): MarkdownRenderer {
  if (!instance) instance = new MarkdownRenderer();
  return instance;
}
