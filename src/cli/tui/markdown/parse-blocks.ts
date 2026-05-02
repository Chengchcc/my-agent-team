import { parse, postprocess, preprocess } from 'micromark';
import { gfm } from 'micromark-extension-gfm';
import type { Event, Token } from 'micromark-util-types';

export interface Block {
  id: string;
  type: BlockType;
  startOffset: number;
  endOffset: number;
  raw: string;
  /** For code blocks, the info string (language). */
  info?: string;
  /** For list items, the ordered/unordered marker. */
  listKind?: 'ordered' | 'unordered';
  /** 1-based index for ordered list items. */
  itemIndex?: number;
  /** Heading level 1-6 (atx and setext). */
  level?: number;
}

export type BlockType =
  | 'heading'
  | 'codeFenced'
  | 'codeIndented'
  | 'paragraph'
  | 'listItem'
  | 'blockquote'
  | 'thematicBreak'
  | 'table'
  | 'htmlFlow'
  | 'definition'
  | 'other';

const TOP_BLOCK_TYPES = new Set([
  'atxHeading',
  'setextHeading',
  'codeFenced',
  'codeIndented',
  'paragraph',
  'blockQuote',
  'thematicBreak',
  'htmlFlow',
  // GFM extensions
  'table',
]);

function mapType(tokenType: string): BlockType {
  if (tokenType === 'atxHeading' || tokenType === 'setextHeading') return 'heading';
  if (tokenType === 'codeFenced') return 'codeFenced';
  if (tokenType === 'codeIndented') return 'codeIndented';
  if (tokenType === 'paragraph') return 'paragraph';
  if (tokenType === 'blockQuote') return 'blockquote';
  if (tokenType === 'thematicBreak') return 'thematicBreak';
  if (tokenType === 'table') return 'table';
  if (tokenType === 'htmlFlow') return 'htmlFlow';
  // definition and footnoteDefinition are skipped (no block created)
  return 'other';
}

function isTopBlockType(type: string): boolean {
  return TOP_BLOCK_TYPES.has(type);
}

export function parseToBlocks(content: string): Block[] {
  if (!content) return [];

  const events: Event[] = postprocess(
    parse({ extensions: [gfm()] }).document().write(
      preprocess()(content, null, true),
    ),
  );

  const blocks: Block[] = [];
  let topDepth = 0;
  let currentBlockIdx = -1;

  // Per-list state: kind of list we are inside, and next item index.
  let listKind: 'ordered' | 'unordered' | null = null;
  let itemIndex = 0;

  for (const [kind, token] of events) {
    const ttype: string = token.type;

    // Container types that suppress inner blocks but produce no output themselves.
    const isSilentContainer =
      ttype === 'listOrdered' ||
      ttype === 'listUnordered' ||
      ttype === 'definition' ||
      ttype === 'footnoteDefinition' ||
      ttype === 'gfmFootnoteDefinition';

    // ── List containers: track depth + context, never create blocks ──
    if (isSilentContainer) {
      if (kind === 'enter') {
        if (ttype === 'listOrdered' || ttype === 'listUnordered') {
          listKind = ttype === 'listOrdered' ? 'ordered' : 'unordered';
          itemIndex = 0;
        }
        topDepth++;
      } else {
        if (ttype === 'listOrdered' || ttype === 'listUnordered') {
          // Finalise the last listItem at the list boundary
          const lastItem = blocks[blocks.length - 1];
          if (lastItem && lastItem.type === 'listItem') {
            lastItem.endOffset = token.end.offset;
            lastItem.raw = content.slice(lastItem.startOffset, lastItem.endOffset);
          }
          listKind = null;
          itemIndex = 0;
        }
        topDepth--;
      }
      continue;
    }

    // ── Top-level block tracking ──
    if (isTopBlockType(ttype)) {
      if (kind === 'enter') {
        topDepth++;
        if (topDepth === 1) {
          blocks.push(buildBlock(token, content, mapType(ttype)));
          currentBlockIdx = blocks.length - 1;
        }
      } else {
        topDepth--;
        if (topDepth === 0 && currentBlockIdx >= 0) {
          const b = blocks[currentBlockIdx];
          if (b) {
            b.endOffset = token.end.offset;
            b.raw = content.slice(b.startOffset, b.endOffset);

            // Extract heading level from raw text
            if (b.type === 'heading') {
              const lines = b.raw.split('\n');
              const lastLine = lines[lines.length - 1]!;
              if (/^=+$/.test(lastLine)) {
                b.level = 1; // setext H1
              } else if (/^-+$/.test(lastLine)) {
                b.level = 2; // setext H2
              } else {
                const atxMatch = b.raw.match(/^(#{1,6})\s/);
                b.level = atxMatch ? atxMatch[1]!.length : 1;
              }
            }
          }
          currentBlockIdx = -1;
        }
      }
    }

    // ── List-item markers ──
    else if (ttype === 'listItemPrefix' && kind === 'enter') {
      // Close the previous listItem at the new item's boundary
      const prevItem = blocks[blocks.length - 1];
      if (prevItem && prevItem.type === 'listItem') {
        prevItem.endOffset = token.start.offset;
        prevItem.raw = content.slice(prevItem.startOffset, prevItem.endOffset);
      }
      itemIndex++;
      const item = buildBlock(token, content, 'listItem');
      if (listKind) {
        item.listKind = listKind;
        if (listKind === 'ordered') {
          item.itemIndex = itemIndex;
        }
      }
      blocks.push(item);
    }
  }

  // Finalize the last listItem if it extends to end of content
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'listItem') {
    last.endOffset = content.length;
    last.raw = content.slice(last.startOffset, last.endOffset);
  }

  return blocks;
}

function buildBlock(token: Token, content: string, type: BlockType): Block {
  const startOffset = token.start.offset;
  const endOffset = token.end.offset; // may be updated on exit

  const block: Block = {
    id: `${type}-${startOffset}`,
    type,
    startOffset,
    endOffset,
    raw: content.slice(startOffset, endOffset),
  };

  // Extract info string for fenced code
  if (type === 'codeFenced') {
    const firstNewline = block.raw.indexOf('\n');
    const fenceLine = firstNewline === -1 ? block.raw : block.raw.slice(0, firstNewline);
    const info = fenceLine.replace(/^[`~]{3,}\s*/, '').trim();
    if (info) block.info = info;
  }

  return block;
}
