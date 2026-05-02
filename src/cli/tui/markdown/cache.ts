import React from 'react';
import { Text } from 'ink';
import { parseDoc, type Block } from './parse-ast';
import { renderBlocks, FootnotesSection, type RenderContext } from './render-ast';

const MAX_CACHE_SIZE = 300;
const EVICT_BATCH = 50;

/**
 * Caches rendered React nodes for committed blocks.
 * Once committed, a block's raw content never changes, so cache hit rate is ~100%.
 */
export class MarkdownRenderer {
  private renderCache = new Map<string, React.ReactNode>();
  private splitCache = new Map<string, { stable: React.ReactNode[]; tail: React.ReactNode[] }>();
  private lastContent = '';
  private lastCommittedLength = 0;
  private lastTerminalWidth = 80;
  private lastBlocks: Block[] = [];
  private lastDefinitions = new Map();
  private lastFootnotes = new Map();

  render(content: string, committedLength: number, terminalWidth: number): { stable: React.ReactNode[]; tail: React.ReactNode[] } {
    // Fast path: same content, committedLength, and terminalWidth → return cached
    if (
      content === this.lastContent &&
      committedLength === this.lastCommittedLength &&
      terminalWidth === this.lastTerminalWidth
    ) {
      const splitHit = this.splitCache.get(this.cacheKey(content, committedLength, terminalWidth));
      if (splitHit) return splitHit;
    }

    // Parse if content changed
    let blocks: Block[];
    let definitions = this.lastDefinitions;
    let footnotes = this.lastFootnotes;
    if (content === this.lastContent) {
      blocks = this.lastBlocks;
    } else {
      const doc = parseDoc(content);
      blocks = doc.blocks;
      definitions = doc.definitions;
      footnotes = doc.footnotes;
      this.lastContent = content;
      this.lastBlocks = blocks;
      this.lastDefinitions = definitions;
      this.lastFootnotes = footnotes;
    }

    const ctx: RenderContext = { terminalWidth, definitions, footnotes };
    const result = renderBlocks(blocks, committedLength, ctx);
    this.lastCommittedLength = committedLength;
    this.lastTerminalWidth = terminalWidth;

    // When no markdown blocks are detected (plain text), render trailing
    // content as raw text so it appears in the live TUI output.
    if (blocks.length === 0 && committedLength < content.length) {
      result.tail.push(React.createElement(Text, { key: 'raw-tail' }, content.slice(committedLength)));
    }

    // Append footnotes section to stable when fully committed
    if (committedLength >= content.length && footnotes.size > 0) {
      result.stable.push(
        React.createElement(
          'x-footnotes' as any,
          { key: 'footnotes-section' },
          FootnotesSection({ footnotes, ctx }),
        ),
      );
    }

    // Evict old entries if cache is too large
    if (this.renderCache.size > MAX_CACHE_SIZE) {
      const keys = [...this.renderCache.keys()];
      for (let i = 0; i < EVICT_BATCH && keys[i]; i++) {
        this.renderCache.delete(keys[i]!);
      }
    }

    this.splitCache.set(this.cacheKey(content, committedLength, terminalWidth), result);
    return result;
  }

  reset(): void {
    this.renderCache.clear();
    this.splitCache.clear();
    this.lastContent = '';
    this.lastCommittedLength = 0;
    this.lastTerminalWidth = 80;
    this.lastBlocks = [];
    this.lastDefinitions = new Map();
    this.lastFootnotes = new Map();
  }

  private cacheKey(content: string, committedLength: number, terminalWidth: number): string {
    // Include head + tail snippets to prevent collisions when two segments
    // happen to have the same committedLength + content length + width.
    return `${committedLength}:${content.length}:${terminalWidth}:${content.slice(0, 8)}:${content.slice(-4)}`;
  }
}

/** Singleton for TUI process lifetime. */
let instance: MarkdownRenderer | null = null;

export function getMarkdownRenderer(): MarkdownRenderer {
  if (!instance) instance = new MarkdownRenderer();
  return instance;
}
