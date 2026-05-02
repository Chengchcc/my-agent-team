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
}

export type BlockType =
  | 'heading'
  | 'codeFenced'
  | 'codeIndented'
  | 'paragraph'
  | 'list'
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
  'listOrdered',
  'listUnordered',
  'blockQuote',
  'thematicBreak',
  'htmlFlow',
  'definition',
  // GFM extensions
  'table',
  'footnoteDefinition',
]);

function mapType(tokenType: string): BlockType {
  if (tokenType === 'atxHeading' || tokenType === 'setextHeading') return 'heading';
  if (tokenType === 'codeFenced') return 'codeFenced';
  if (tokenType === 'codeIndented') return 'codeIndented';
  if (tokenType === 'paragraph') return 'paragraph';
  if (tokenType === 'listOrdered' || tokenType === 'listUnordered') return 'list';
  if (tokenType === 'listItem') return 'listItem';
  if (tokenType === 'blockQuote') return 'blockquote';
  if (tokenType === 'thematicBreak') return 'thematicBreak';
  if (tokenType === 'table') return 'table';
  if (tokenType === 'htmlFlow') return 'htmlFlow';
  if (tokenType === 'definition') return 'definition';
  return 'other';
}

function isTopBlockType(type: string): boolean {
  return TOP_BLOCK_TYPES.has(type);
}

// Parsing is synchronous. micromark doesn't throw on invalid input.
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

  for (const [kind, token] of events) {
    const ttype: string = token.type;

    // Track top-level block depth
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
          }
          currentBlockIdx = -1;
        }
      }
    }
    // listItemPrefix marks the start of each list item inside a list.
    // micromark does not emit 'listItem' events — the list structure is:
    // listOrdered/listUnordered > listItemPrefix (marker) > content > paragraph
    else if (ttype === 'listItemPrefix' && kind === 'enter') {
      // Close previous listItem if open
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'listItem') {
        last.endOffset = token.start.offset;
        last.raw = content.slice(last.startOffset, last.endOffset);
      }
      blocks.push(buildBlock(token, content, 'listItem'));
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
    // The info string is between the first fence and the newline
    const firstNewline = block.raw.indexOf('\n');
    const fenceLine = firstNewline === -1 ? block.raw : block.raw.slice(0, firstNewline);
    // Strip leading backticks/tildes and whitespace
    const info = fenceLine.replace(/^[`~]{3,}\s*/, '').trim();
    if (info) block.info = info;
  }

  return block;
}
