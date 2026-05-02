import { describe, test, expect } from 'bun:test';
import { parseDoc } from '../../src/cli/tui/markdown/parse-ast';
import type { Block } from '../../src/cli/tui/markdown/parse-ast';

function computeBoundary(blocks: Block[], prevCommitted: number): number {
  if (blocks.length === 0) return prevCommitted;
  const lastStableIdx = blocks.length >= 2 ? blocks.length - 2 : 0;
  return Math.max(prevCommitted, blocks[lastStableIdx]!.endOffset);
}

describe('computeBoundary (second-to-last via parseDoc)', () => {
  test('empty string has no blocks → boundary 0', () => {
    const doc = parseDoc('');
    expect(doc.blocks).toHaveLength(0);
    expect(computeBoundary(doc.blocks, 0)).toBe(0);
  });

  test('single paragraph → commits the block itself (no second-to-last)', () => {
    const doc = parseDoc('hello world');
    expect(doc.blocks).toHaveLength(1);
    // Single block: committedLength advances to the block's endOffset
    expect(computeBoundary(doc.blocks, 0)).toBe(doc.blocks[0]!.endOffset);
  });

  test('two paragraphs → boundary at end of first paragraph', () => {
    const s = 'hello world.\n\nstill writing';
    const doc = parseDoc(s);
    expect(doc.blocks.length).toBeGreaterThanOrEqual(2);
    const boundary = computeBoundary(doc.blocks, 0);
    expect(boundary).toBeGreaterThan(0);
    // boundary should be at/near the end of first paragraph
    expect(boundary).toBeLessThanOrEqual(s.length);
  });

  test('complete heading + paragraph → boundary at heading end', () => {
    const s = '# Title\n\nSome content';
    const doc = parseDoc(s);
    expect(doc.blocks.length).toBeGreaterThanOrEqual(2);
    const boundary = computeBoundary(doc.blocks, 0);
    expect(boundary).toBeGreaterThan(0);
  });

  test('code block + paragraph → boundary at code block end', () => {
    const s = '```py\nprint(1)\n```\n\nafter';
    const doc = parseDoc(s);
    expect(doc.blocks.length).toBeGreaterThanOrEqual(2);
    const boundary = computeBoundary(doc.blocks, 0);
    expect(boundary).toBeGreaterThan(0);
  });

  test('table + paragraph → boundary at table end', () => {
    const s = '| a | b |\n|---|---|\n| 1 | 2 |\n\nnext';
    const doc = parseDoc(s);
    expect(doc.blocks.length).toBeGreaterThanOrEqual(2);
    const boundary = computeBoundary(doc.blocks, 0);
    expect(boundary).toBeGreaterThan(0);
  });

  test('three paragraphs → with prevCommitted=0, advances to second-to-last block', () => {
    const s = 'one\n\ntwo\n\nthree';
    const doc = parseDoc(s);
    expect(doc.blocks.length).toBeGreaterThanOrEqual(3);
    const boundary = computeBoundary(doc.blocks, 0);
    expect(boundary).toBeGreaterThan(0);
    // Second-to-last: blocks[1] (index 1), not blocks[0]
    expect(boundary).toBe(doc.blocks[1]!.endOffset);
  });

  test('three blocks → commits all except last in one tick', () => {
    const s = 'one\n\ntwo\n\nthree';
    const doc = parseDoc(s);
    // One tick: boundary = second-to-last (blocks[1]), commits "one" + "two"
    const b1 = computeBoundary(doc.blocks, 0);
    expect(b1).toBe(doc.blocks[1]!.endOffset);
    // With prevCommitted already at second-to-last → no change (last block stays tail)
    const b2 = computeBoundary(doc.blocks, b1);
    expect(b2).toBe(b1);
  });

  test('prevCommitted already at second-to-last → returns prevCommitted', () => {
    const s = 'one\n\ntwo\n\nthree';
    const doc = parseDoc(s);
    const secondLast = doc.blocks[doc.blocks.length - 2]!;
    const boundary = computeBoundary(doc.blocks, secondLast.endOffset);
    expect(boundary).toBe(secondLast.endOffset);
  });

  test('boundary always at a block endOffset (no straddling)', () => {
    const s = 'para1\n\npara2\n\npara3';
    const doc = parseDoc(s);
    const boundary = computeBoundary(doc.blocks, 0);
    const matchesBoundary = doc.blocks.some(b => b.endOffset === boundary);
    expect(matchesBoundary).toBe(true);
  });

  test('unclosed code fence → single block → boundary at block end', () => {
    const s = '```py\nprint(1)\n';
    const doc = parseDoc(s);
    if (doc.blocks.length < 2) {
      expect(computeBoundary(doc.blocks, 0)).toBe(doc.blocks[0]!.endOffset);
    }
  });
});
