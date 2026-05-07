import { describe, it, expect } from 'bun:test';
import { shouldReparse, extendLastBlock } from '../../src/cli/tui/streaming/committer';
import { parseDoc } from '../../src/cli/tui/markdown/parse-ast';

describe('shouldReparse', () => {
  it('returns false when content is identical', () => {
    const content = 'hello world';
    expect(shouldReparse(content, content)).toBe(false);
  });

  it('returns false for small growth without blank line', () => {
    const cached = 'hello';
    const next = 'hello world';
    expect(shouldReparse(next, cached)).toBe(false);
  });

  it('returns true when new portion contains double newline', () => {
    const cached = '# Heading\n\nparagraph one';
    const next = '# Heading\n\nparagraph one\n\nparagraph two';
    expect(shouldReparse(next, cached)).toBe(true);
  });

  it('returns true when growth exceeds threshold (80 chars)', () => {
    const cached = 'short';
    const next = 'short' + 'x'.repeat(80);
    expect(shouldReparse(next, cached)).toBe(true);
  });

  it('returns false for growth of 79 chars without blank line', () => {
    const cached = 'short';
    const next = 'short' + 'x'.repeat(79);
    expect(shouldReparse(next, cached)).toBe(false);
  });

  it('returns false when new portion is shorter (should not happen but defensively correct)', () => {
    const cached = 'hello world';
    const next = 'hello';
    // growth = -6, which is < 80
    // newPortion = '' (empty slice when cached > new)
    expect(shouldReparse(next, cached)).toBe(false);
  });
});

describe('extendLastBlock', () => {
  it('returns doc unchanged when no blocks', () => {
    const doc = parseDoc('');
    const result = extendLastBlock(doc, 'new content');
    expect(result.blocks).toHaveLength(0);
  });

  it('extends last block endOffset and raw to cover new content', () => {
    const doc = parseDoc('hello world');
    const newContent = 'hello world, extended';
    const result = extendLastBlock(doc, newContent);

    expect(result.blocks).toHaveLength(1);
    const lastBlock = result.blocks[0]!;
    expect(lastBlock.endOffset).toBe(newContent.length);
    expect(lastBlock.raw).toBe(newContent.slice(lastBlock.startOffset));
  });

  it('does not mutate original doc blocks', () => {
    const doc = parseDoc('hello world');
    const originalEnd = doc.blocks[0]!.endOffset;
    const originalRaw = doc.blocks[0]!.raw;

    extendLastBlock(doc, 'hello world, extended');

    expect(doc.blocks[0]!.endOffset).toBe(originalEnd);
    expect(doc.blocks[0]!.raw).toBe(originalRaw);
  });

  it('preserves non-last blocks unchanged', () => {
    const doc = parseDoc('first block\n\nsecond block');
    expect(doc.blocks).toHaveLength(2);

    const result = extendLastBlock(doc, 'first block\n\nsecond block extended more');

    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]!.endOffset).toBe(doc.blocks[0]!.endOffset);
    expect(result.blocks[0]!.raw).toBe(doc.blocks[0]!.raw);
    expect(result.blocks[1]!.endOffset).toBe('first block\n\nsecond block extended more'.length);
  });

  it('preserves definitions and footnotes', () => {
    const doc = parseDoc('[ref]: https://example.com\n\ntext');
    const result = extendLastBlock(doc, '[ref]: https://example.com\n\ntext extended');

    expect(result.definitions).toBe(doc.definitions);
    expect(result.footnotes).toBe(doc.footnotes);
  });
});
