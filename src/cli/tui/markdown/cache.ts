import React from 'react';
import { Text } from 'ink';
import { parseToBlocks, type Block } from './parse-blocks';
import { renderBlock, renderBlocks } from './render-block';

const MAX_CACHE_SIZE = 300;
const EVICT_BATCH = 50;

/**
 * Caches rendered React nodes for blocks and stable/tail splits.
 * Block identity is derived from (type, startOffset, endOffset, raw hash) —
 * once committed, a block's raw content never changes, so cache hit rate is ~100%.
 */
export class MarkdownRenderer {
  private blockCache = new Map<string, React.ReactNode>();
  private splitCache = new Map<string, { stable: React.ReactNode[]; tail: React.ReactNode[] }>();
  private lastContent = '';
  private lastCommittedLength = 0;
  private lastBlocks: Block[] = [];

  /**
   * Render content with committed/tail split.
   * Returns stable (cached per block) and tail (raw text) React nodes.
   */
  render(content: string, committedLength: number): { stable: React.ReactNode[]; tail: React.ReactNode[] } {
    // Fast path: same content and committedLength → return cached
    if (content === this.lastContent && committedLength === this.lastCommittedLength) {
      const splitHit = this.splitCache.get(this.cacheKey(content, committedLength));
      if (splitHit) return splitHit;
    }

    // Parse if content changed
    let blocks: Block[];
    if (content === this.lastContent) {
      blocks = this.lastBlocks;
    } else {
      blocks = parseToBlocks(content);
      this.lastContent = content;
      this.lastBlocks = blocks;
    }

    const result = renderBlocks(blocks, committedLength);
    this.lastCommittedLength = committedLength;

    // When no markdown blocks are detected (plain text), render trailing
    // content as raw text so it appears in the live TUI output.
    if (blocks.length === 0 && committedLength < content.length) {
      result.tail.push(React.createElement(Text, { key: 'raw-tail' }, content.slice(committedLength)));
    }

    // Evict old entries if cache is too large
    if (this.blockCache.size > MAX_CACHE_SIZE) {
      const keys = [...this.blockCache.keys()];
      for (let i = 0; i < EVICT_BATCH && keys[i]; i++) {
        this.blockCache.delete(keys[i]!);
      }
    }

    this.splitCache.set(this.cacheKey(content, committedLength), result);
    return result;
  }

  /** Render a single block with caching. */
  renderCached(block: Block): React.ReactNode {
    const key = `${block.id}-${block.raw.length}`;
    const hit = this.blockCache.get(key);
    if (hit !== undefined) return hit;

    const rendered = renderBlock(block);
    this.blockCache.set(key, rendered);
    return rendered;
  }

  reset(): void {
    this.blockCache.clear();
    this.splitCache.clear();
    this.lastContent = '';
    this.lastCommittedLength = 0;
    this.lastBlocks = [];
  }

  private cacheKey(content: string, committedLength: number): string {
    return `${committedLength}:${content.length}`;
  }
}

/** Singleton for TUI process lifetime. */
let instance: MarkdownRenderer | null = null;

export function getMarkdownRenderer(): MarkdownRenderer {
  if (!instance) instance = new MarkdownRenderer();
  return instance;
}
