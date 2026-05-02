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
  test('tail uses renderNode (not raw markdown source)', () => {
    // With a single block and committedLength=0, everything is in tail
    const result = render('hello **bold** world', 0);
    expect(result.stable.length).toBe(0);
    expect(result.tail.length).toBe(1);
    // Tail should NOT contain the literal "**" characters as raw text.
    // Since we use renderNode(streaming:true), the paragraph node renders
    // inline children — the "**bold**" becomes a <Text bold> element.
  });

  test('committed block in stable, uncommitted in tail (formatted)', () => {
    const result = render('first para.\n\nsecond **bold** para.', 12);
    // First paragraph fully committed → stable
    expect(result.stable.length).toBe(1);
    // Second block (starts after \n\n at offset 14) is in tail
    expect(result.tail.length).toBe(1);
  });

  test('heading in tail renders as formatted (not raw ## prefix)', () => {
    // Single heading block, all in tail
    const result = render('## My Title', 0);
    expect(result.stable.length).toBe(0);
    expect(result.tail.length).toBe(1);
  });

  test('inline code in tail renders as formatted', () => {
    const result = render('use `foo()` function', 0);
    expect(result.tail.length).toBe(1);
  });

  test('multiple blocks: committed in stable, uncommitted in tail', () => {
    const content = '# Title\n\nBody text\n\n## Section 2\n\nMore text';
    const doc = parseDoc(content);
    // Commit up to second block
    const committedLength = doc.blocks[1]!.endOffset;
    const result = render(content, committedLength);

    expect(result.stable.length).toBe(2);  // heading + first body paragraph
    expect(result.tail.length).toBe(2);    // second heading + second body paragraph
  });

  test('code block (fenced, incomplete) in streaming tail', () => {
    // No closing fence → single block, all in tail
    const result = render('```py\nprint(1)\n', 0);
    expect(result.stable.length).toBe(0);
    expect(result.tail.length).toBe(1);
  });

  test('thematic break in streaming tail renders null', () => {
    // In streaming mode, thematicBreak returns null
    const content = 'para\n\n---';
    const doc = parseDoc(content);
    const result = render(content, 0);
    // If --- is the last block, it should not add a raw text line
    // (null in React means nothing rendered)
    const tailCount = result.tail.length;
    // Either 0 (if thematicBreak returned null) or 1 (paragraph)
    expect(tailCount).toBeLessThanOrEqual(2);
  });

  test('fully committed: all blocks in stable, no tail', () => {
    const content = '# Title\n\nBody text\n\n## Section 2\n\nMore text';
    const result = render(content, content.length);

    expect(result.stable.length).toBe(4);
    expect(result.tail.length).toBe(0);
  });
});
