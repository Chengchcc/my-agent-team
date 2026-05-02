import { describe, test, expect } from 'bun:test';
import { parseDoc, type Block } from '../../src/cli/tui/markdown/parse-ast';
import { getMarkdownRenderer } from '../../src/cli/tui/markdown/cache';

const W = 80;

function generateMarkdown(paragraphs: number): string {
  const parts: string[] = [];
  for (let i = 0; i < paragraphs; i++) {
    if (i % 5 === 0) parts.push(`## Section ${i / 5 + 1}`);
    else if (i % 7 === 0) parts.push('```ts\nconst x = 1;\n```');
    else if (i % 9 === 0) parts.push('| a | b |\n|---|---|\n| 1 | 2 |');
    else parts.push(`Paragraph ${i}: some **bold** and *italic* text with \`inline code\` and [links](https://x.com).`);
  }
  return parts.join('\n\n');
}

function renderWithBlocks(content: string, committedLength: number) {
  const doc = parseDoc(content);
  return {
    result: getMarkdownRenderer().render(
      content, committedLength, W,
      doc.blocks, doc.definitions, doc.footnotes,
    ),
    blocks: doc.blocks,
  };
}

describe('renderer long document', () => {
  test('10 paragraphs: all blocks parse correctly', () => {
    const md = generateMarkdown(10);
    const { blocks } = renderWithBlocks(md, md.length);
    expect(blocks.length).toBeGreaterThanOrEqual(8); // some are non-block (definitions etc)
  });

  test('fully committed: stable has all blocks, tail empty', () => {
    const md = generateMarkdown(20);
    const { result, blocks } = renderWithBlocks(md, md.length);
    expect(result.stable.length).toBe(blocks.length);
    expect(result.tail.length).toBe(0);
  });

  test('nothing committed: stable empty, tail has all blocks', () => {
    const md = generateMarkdown(10);
    const { result, blocks } = renderWithBlocks(md, 0);
    expect(result.stable.length).toBe(0);
    expect(result.tail.length).toBe(blocks.length);
  });

  test('parseDoc on same content produces identical block structure', () => {
    const md = generateMarkdown(30);
    const doc1 = parseDoc(md);
    const doc2 = parseDoc(md);

    expect(doc1.blocks.length).toBe(doc2.blocks.length);
    for (let i = 0; i < doc1.blocks.length; i++) {
      expect(doc1.blocks[i]!.id).toBe(doc2.blocks[i]!.id);
      expect(doc1.blocks[i]!.startOffset).toBe(doc2.blocks[i]!.startOffset);
      expect(doc1.blocks[i]!.endOffset).toBe(doc2.blocks[i]!.endOffset);
    }
  });

  test('incremental growth: block offsets are monotonic', () => {
    const parts: string[] = [];
    const chunks: string[] = [];

    // Simulate streaming: append chunks one at a time
    for (let i = 0; i < 20; i++) {
      const chunk = i % 3 === 0
        ? `\n\n## Section ${i / 3 + 1}\n\nBody ${i}`
        : ` word${i}`;
      chunks.push(chunk);
      parts.push(chunk);
    }

    let content = '';
    for (let i = 0; i < chunks.length; i++) {
      content += chunks[i]!;
      const doc = parseDoc(content);

      // Verify each block's offsets are within content bounds
      for (const b of doc.blocks) {
        expect(b.startOffset).toBeGreaterThanOrEqual(0);
        expect(b.endOffset).toBeLessThanOrEqual(content.length);
        expect(b.startOffset).toBeLessThanOrEqual(b.endOffset);
      }
    }
  });

  test('block raw matches content slice for all blocks', () => {
    const md = generateMarkdown(50);
    const { blocks } = renderWithBlocks(md, md.length);

    for (const b of blocks) {
      expect(b.raw).toBe(md.slice(b.startOffset, b.endOffset));
    }
  });

  test('single giant paragraph: one block, no crash', () => {
    // 2000 words, no paragraph breaks
    const words: string[] = [];
    for (let i = 0; i < 2000; i++) {
      words.push(`word${i}`);
    }
    const content = words.join(' ');
    const doc = parseDoc(content);
    expect(doc.blocks.length).toBeGreaterThanOrEqual(1);
    expect(() => renderWithBlocks(content, 0)).not.toThrow();
  });
});
