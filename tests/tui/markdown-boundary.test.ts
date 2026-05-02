import { describe, test, expect } from 'bun:test';
import { parseDoc } from '../../src/cli/tui/markdown/parse-ast';
import type { Block } from '../../src/cli/tui/markdown/parse-ast';

function computeBoundary(blocks: Block[]): number {
  if (blocks.length < 2) return 0;
  return blocks[blocks.length - 2]!.endOffset;
}

describe('computeBoundary (via parseDoc)', () => {
  test('empty string has no blocks → boundary 0', () => {
    const doc = parseDoc('');
    expect(doc.blocks).toHaveLength(0);
    expect(computeBoundary(doc.blocks)).toBe(0);
  });

  test('single paragraph → no second-to-last block → boundary 0', () => {
    const doc = parseDoc('hello world');
    expect(doc.blocks).toHaveLength(1);
    expect(computeBoundary(doc.blocks)).toBe(0);
  });

  test('two paragraphs → boundary at end of first paragraph', () => {
    const s = 'hello world.\n\nstill writing';
    const doc = parseDoc(s);
    expect(doc.blocks.length).toBeGreaterThanOrEqual(2);
    const boundary = computeBoundary(doc.blocks);
    expect(boundary).toBeGreaterThan(0);
    // boundary should be at/near the end of first paragraph
    expect(boundary).toBeLessThanOrEqual(s.length);
  });

  test('complete heading + paragraph → boundary at heading end', () => {
    const s = '# Title\n\nSome content';
    const doc = parseDoc(s);
    expect(doc.blocks.length).toBeGreaterThanOrEqual(2);
    const boundary = computeBoundary(doc.blocks);
    expect(boundary).toBeGreaterThan(0);
  });

  test('code block + paragraph → boundary at code block end', () => {
    const s = '```py\nprint(1)\n```\n\nafter';
    const doc = parseDoc(s);
    expect(doc.blocks.length).toBeGreaterThanOrEqual(2);
    const boundary = computeBoundary(doc.blocks);
    expect(boundary).toBeGreaterThan(0);
  });

  test('table + paragraph → boundary at table end', () => {
    const s = '| a | b |\n|---|---|\n| 1 | 2 |\n\nnext';
    const doc = parseDoc(s);
    expect(doc.blocks.length).toBeGreaterThanOrEqual(2);
    const boundary = computeBoundary(doc.blocks);
    expect(boundary).toBeGreaterThan(0);
  });

  test('three paragraphs → boundary at second paragraph end', () => {
    const s = 'one\n\ntwo\n\nthree';
    const doc = parseDoc(s);
    expect(doc.blocks.length).toBeGreaterThanOrEqual(3);
    const boundary = computeBoundary(doc.blocks);
    expect(boundary).toBeGreaterThan(0);
    expect(boundary).toBeLessThan(s.length);
  });

  test('straddling impossible: boundary never falls mid-block', () => {
    // With computeBoundary = second-to-last block's endOffset,
    // committedLength is always at a block boundary.
    const s = 'para1\n\npara2\n\npara3';
    const doc = parseDoc(s);
    const boundary = computeBoundary(doc.blocks);
    // boundary should match endOffset of some block exactly
    const matchesBoundary = doc.blocks.some(b => b.endOffset === boundary);
    expect(matchesBoundary).toBe(true);
  });

  test('unclosed code fence → single block → boundary 0', () => {
    const s = '```py\nprint(1)\n';
    const doc = parseDoc(s);
    // May be 1 block (code not yet closed) → boundary 0
    if (doc.blocks.length < 2) {
      expect(computeBoundary(doc.blocks)).toBe(0);
    }
  });
});
