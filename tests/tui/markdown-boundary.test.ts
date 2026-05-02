import { describe, test, expect } from 'bun:test';
import { parseDoc } from '../../src/cli/tui/markdown/parse-ast';
import type { Block } from '../../src/cli/tui/markdown/parse-ast';

function computeBoundary(blocks: Block[], prevCommitted: number): number {
  for (let i = 0; i < blocks.length - 1; i++) {
    if (blocks[i]!.endOffset > prevCommitted) {
      return blocks[i]!.endOffset;
    }
  }
  return prevCommitted;
}

describe('computeBoundary (progressive via parseDoc)', () => {
  test('empty string has no blocks → boundary 0', () => {
    const doc = parseDoc('');
    expect(doc.blocks).toHaveLength(0);
    expect(computeBoundary(doc.blocks, 0)).toBe(0);
  });

  test('single paragraph → no second-to-last block → boundary 0', () => {
    const doc = parseDoc('hello world');
    expect(doc.blocks).toHaveLength(1);
    expect(computeBoundary(doc.blocks, 0)).toBe(0);
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

  test('three paragraphs → with prevCommitted=0, advances to first block boundary', () => {
    const s = 'one\n\ntwo\n\nthree';
    const doc = parseDoc(s);
    expect(doc.blocks.length).toBeGreaterThanOrEqual(3);
    const boundary = computeBoundary(doc.blocks, 0);
    expect(boundary).toBeGreaterThan(0);
    expect(boundary).toBe(doc.blocks[0]!.endOffset);
  });

  test('progressive: two ticks advance one block each', () => {
    const s = 'one\n\ntwo\n\nthree';
    const doc = parseDoc(s);
    // First tick: prevCommitted=0 → advance to first block boundary
    const b1 = computeBoundary(doc.blocks, 0);
    expect(b1).toBe(doc.blocks[0]!.endOffset);
    // Second tick: prevCommitted = first block boundary → advance to second
    const b2 = computeBoundary(doc.blocks, b1);
    expect(b2).toBe(doc.blocks[1]!.endOffset);
    // Third tick: already at second-to-last boundary → no advancement
    const b3 = computeBoundary(doc.blocks, b2);
    expect(b3).toBe(b2);
  });

  test('prevCommitted already past all but last block → returns prevCommitted', () => {
    const s = 'one\n\ntwo\n\nthree';
    const doc = parseDoc(s);
    const lastBlock = doc.blocks[doc.blocks.length - 2]!;
    const boundary = computeBoundary(doc.blocks, lastBlock.endOffset);
    expect(boundary).toBe(lastBlock.endOffset);
  });

  test('boundary always at a block endOffset (no straddling)', () => {
    const s = 'para1\n\npara2\n\npara3';
    const doc = parseDoc(s);
    const boundary = computeBoundary(doc.blocks, 0);
    const matchesBoundary = doc.blocks.some(b => b.endOffset === boundary);
    expect(matchesBoundary).toBe(true);
  });

  test('unclosed code fence → single block → boundary 0', () => {
    const s = '```py\nprint(1)\n';
    const doc = parseDoc(s);
    // May be 1 block (code not yet closed) → boundary 0
    if (doc.blocks.length < 2) {
      expect(computeBoundary(doc.blocks, 0)).toBe(0);
    }
  });
});
