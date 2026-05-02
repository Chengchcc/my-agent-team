import { parse, postprocess, preprocess } from 'micromark';
import { gfm } from 'micromark-extension-gfm';
import type { Event } from 'micromark-util-types';

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

export interface StableResult {
  boundary: number;
  committable: boolean;
}

/**
 * Find the largest offset such that content.slice(0, boundary) will never
 * change its markdown parse structure.
 *
 * Uses micromark events: a top-level block that has been fully exited AND
 * whose end offset does not reach EOF (there is subsequent content) is
 * structurally stable — future appended content cannot alter it.
 *
 * Blocks that extend to end-of-document are treated as still-open because
 * appending characters could change their structure.
 */
export function findStableBoundary(content: string): StableResult {
  if (!content) return { boundary: 0, committable: false };

  const len = content.length;

  let events: Event[];
  try {
    events = postprocess(
      parse({ extensions: [gfm()] }).document().write(
        preprocess()(content, null, true),
      ),
    );
  } catch {
    return { boundary: 0, committable: false };
  }

  let topDepth = 0;
  let lastSafeExit = 0;
  let currentTopEnter = -1;

  for (const [kind, token] of events) {
    if (TOP_BLOCK_TYPES.has(token.type)) {
      if (kind === 'enter') {
        if (topDepth === 0) {
          currentTopEnter = token.start.offset;
        }
        topDepth++;
      } else {
        // kind === 'exit'
        topDepth--;
        if (topDepth === 0) {
          if (token.end.offset < len) {
            lastSafeExit = skipBlankLines(content, token.end.offset, len);
          }
          currentTopEnter = -1;
        }
      }
    }
    // GFM table sub-structures: tableHead exit means header + delimiter
    // row are done and structurally stable.
    else if ((token.type as string) === 'tableHead' && kind === 'exit') {
      if (token.end.offset < len) {
        lastSafeExit = Math.max(lastSafeExit, skipBlankLines(content, token.end.offset, len));
      }
    }
  }

  // If we're still inside an unclosed top-level block, the stable boundary
  // is before it started.
  if (topDepth > 0 && currentTopEnter >= 0) {
    const boundary = currentTopEnter;
    return { boundary, committable: boundary > 0 };
  }

  return {
    boundary: lastSafeExit,
    committable: lastSafeExit > 0,
  };
}

/** Advance past blank lines after a block exit so inter-block whitespace is committed.
 *  Does NOT advance past trailing whitespace at EOF — those aren't separating blocks. */
function skipBlankLines(content: string, offset: number, len: number): number {
  let i = offset;
  while (i < len && content[i] === '\n') {
    i++;
  }
  // Don't consume trailing newlines at EOF — there's no following block yet
  if (i >= len) return offset;
  return i;
}
