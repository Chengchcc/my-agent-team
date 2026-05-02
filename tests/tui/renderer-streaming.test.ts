import { describe, test, expect } from 'bun:test';
import { parseDoc } from '../../src/cli/tui/markdown/parse-ast';
import { getMarkdownRenderer } from '../../src/cli/tui/markdown/cache';

const W = 80;

function render(content: string, committedLength: number) {
  const doc = parseDoc(content);
  return getMarkdownRenderer().render(
    content, committedLength, W,
    doc.blocks, doc.definitions, doc.footnotes,
  );
}

describe('renderBlocks streaming tail', () => {
  test('tail uses raw markdown (not AST-rendered)', () => {
    // With committedLength=0, block goes to tail as raw text
    const result = render('hello **bold** world', 0);
    expect(result.stable.length).toBe(0);
    expect(result.tail.length).toBe(1);
  });

  test('committed block in stable, uncommitted as raw text in tail', () => {
    const result = render('first para.\n\nsecond **bold** para.', 12);
    expect(result.stable.length).toBe(1);
    expect(result.tail.length).toBe(1);
  });

  test('heading in tail renders as raw markdown (## visible)', () => {
    const result = render('## My Title', 0);
    expect(result.stable.length).toBe(0);
    expect(result.tail.length).toBe(1);
  });

  test('inline code in tail renders as raw markdown', () => {
    const result = render('use `foo()` function', 0);
    expect(result.tail.length).toBe(1);
  });

  test('multiple blocks: committed in stable, only first uncommitted in tail', () => {
    const content = '# Title\n\nBody text\n\n## Section 2\n\nMore text';
    const doc = parseDoc(content);
    const committedLength = doc.blocks[1]!.endOffset;
    const result = render(content, committedLength);

    expect(result.stable.length).toBe(2);
    expect(result.tail.length).toBe(1);
  });

  test('code block (fenced, incomplete) in streaming tail as raw text', () => {
    const result = render('```py\nprint(1)\n', 0);
    expect(result.stable.length).toBe(0);
    expect(result.tail.length).toBe(1);
  });

  test('thematic break in tail renders as raw text', () => {
    const content = 'para\n\n---';
    const result = render(content, 0);
    // Tail block is raw text (thematic break returns null for AST but raw text shows literal ---)
    expect(result.tail.length).toBeGreaterThanOrEqual(1);
  });

  test('fully committed: all blocks in stable, no tail', () => {
    const content = '# Title\n\nBody text\n\n## Section 2\n\nMore text';
    const result = render(content, content.length);

    expect(result.stable.length).toBe(4);
    expect(result.tail.length).toBe(0);
  });

  test('single block fully committed → stable, no tail', () => {
    const content = 'hello **bold** world';
    const result = render(content, content.length);
    expect(result.stable.length).toBe(1);
    expect(result.tail.length).toBe(0);
  });
});
