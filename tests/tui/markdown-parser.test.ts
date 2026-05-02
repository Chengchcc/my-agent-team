import { describe, test, expect } from 'bun:test';
import { parseToBlocks, type Block, type BlockType } from '../../src/cli/tui/markdown/parse-blocks';
import { getMarkdownRenderer } from '../../src/cli/tui/markdown/cache';

function blocksOf(types: BlockType[], blocks: Block[]): void {
  expect(blocks.map(b => b.type)).toEqual(types);
}

function blockAt(blocks: Block[], index: number): Block {
  const b = blocks[index];
  if (!b) throw new Error(`No block at index ${index}`);
  return b;
}

// ── parseToBlocks ──

describe('parseToBlocks', () => {
  test('empty string returns empty array', () => {
    expect(parseToBlocks('')).toEqual([]);
  });

  test('single paragraph', () => {
    const blocks = parseToBlocks('hello world');
    blocksOf(['paragraph'], blocks);
    expect(blockAt(blocks, 0).raw).toBe('hello world');
  });

  test('atx heading h1', () => {
    const blocks = parseToBlocks('# Hello');
    blocksOf(['heading'], blocks);
    expect(blockAt(blocks, 0).raw).toBe('# Hello');
  });

  test('atx heading h3', () => {
    const blocks = parseToBlocks('### Deep');
    blocksOf(['heading'], blocks);
    expect(blockAt(blocks, 0).raw).toBe('### Deep');
  });

  test('setext heading', () => {
    const blocks = parseToBlocks('Title\n=====');
    blocksOf(['heading'], blocks);
    expect(blockAt(blocks, 0).raw).toBe('Title\n=====');
  });

  test('setext heading with dashes', () => {
    const blocks = parseToBlocks('Sub\n---');
    blocksOf(['heading'], blocks);
  });

  test('fenced code block', () => {
    const blocks = parseToBlocks('```js\nconst x = 1;\n```');
    blocksOf(['codeFenced'], blocks);
    expect(blockAt(blocks, 0).info).toBe('js');
  });

  test('fenced code without info string', () => {
    const blocks = parseToBlocks('```\nline\n```');
    blocksOf(['codeFenced'], blocks);
    expect(blockAt(blocks, 0).info).toBeUndefined();
  });

  test('tilde fenced code', () => {
    const blocks = parseToBlocks('~~~py\nprint(1)\n~~~');
    blocksOf(['codeFenced'], blocks);
    expect(blockAt(blocks, 0).info).toBe('py');
  });

  test('indented code', () => {
    const blocks = parseToBlocks('    indented line');
    blocksOf(['codeIndented'], blocks);
  });

  test('thematic break (dashes)', () => {
    const blocks = parseToBlocks('---');
    blocksOf(['thematicBreak'], blocks);
  });

  test('thematic break (asterisks)', () => {
    const blocks = parseToBlocks('***');
    blocksOf(['thematicBreak'], blocks);
  });

  test('blockquote single line', () => {
    const blocks = parseToBlocks('> quoted');
    blocksOf(['blockquote'], blocks);
  });

  test('unordered list', () => {
    const blocks = parseToBlocks('- item 1\n- item 2');
    // Only listItem blocks — list containers are not rendered
    const types = blocks.map(b => b.type);
    expect(types).not.toContain('list' as any);
    expect(types).toContain('listItem');
  });

  test('ordered list', () => {
    const blocks = parseToBlocks('1. first\n2. second');
    const types = blocks.map(b => b.type);
    expect(types).not.toContain('list' as any);
    expect(types).toContain('listItem');
  });

  test('listItem has listKind unordered for dashed list', () => {
    const blocks = parseToBlocks('- item');
    expect(blockAt(blocks, 0).listKind).toBe('unordered');
  });

  test('listItem has listKind ordered and itemIndex', () => {
    const blocks = parseToBlocks('1. first\n2. second');
    const items = blocks.filter(b => b.type === 'listItem');
    expect(items[0]?.listKind).toBe('ordered');
    expect(items[0]?.itemIndex).toBe(1);
    expect(items[1]?.listKind).toBe('ordered');
    expect(items[1]?.itemIndex).toBe(2);
  });

  test('atx heading has correct level', () => {
    const h1 = parseToBlocks('# Hello');
    expect(blockAt(h1, 0).level).toBe(1);

    const h3 = parseToBlocks('### Deep');
    expect(blockAt(h3, 0).level).toBe(3);

    const h6 = parseToBlocks('###### Small');
    expect(blockAt(h6, 0).level).toBe(6);
  });

  test('setext heading H1 has level 1', () => {
    const blocks = parseToBlocks('Title\n=====');
    expect(blockAt(blocks, 0).level).toBe(1);
  });

  test('setext heading H2 has level 2', () => {
    const blocks = parseToBlocks('Sub\n---');
    expect(blockAt(blocks, 0).level).toBe(2);
  });

  test('footnoteDefinition produces no block', () => {
    const blocks = parseToBlocks('[^1]: footnote text');
    expect(blocks.length).toBe(0);
  });

  test('link definition produces no block', () => {
    const blocks = parseToBlocks('[label]: /url "title"');
    expect(blocks.length).toBe(0);
  });

  test('GFM table', () => {
    const blocks = parseToBlocks('| a | b |\n|---|---|\n| 1 | 2 |');
    blocksOf(['table'], blocks);
  });

  test('HTML flow', () => {
    const blocks = parseToBlocks('<div>\nhi\n</div>');
    blocksOf(['htmlFlow'], blocks);
  });

  test('multiple paragraphs', () => {
    const blocks = parseToBlocks('first\n\nsecond');
    blocksOf(['paragraph', 'paragraph'], blocks);
    expect(blockAt(blocks, 0).raw).toBe('first');
    expect(blockAt(blocks, 1).raw).toBe('second');
  });

  test('heading followed by paragraph', () => {
    const blocks = parseToBlocks('# Title\n\nbody text');
    blocksOf(['heading', 'paragraph'], blocks);
  });

  test('block offsets are correct', () => {
    const content = 'aaa\n\nbbb';
    const blocks = parseToBlocks(content);
    expect(blockAt(blocks, 0).startOffset).toBe(0);
    expect(blockAt(blocks, 0).endOffset).toBe(3);
    expect(blockAt(blocks, 1).startOffset).toBe(5);
    expect(blockAt(blocks, 1).endOffset).toBe(8);
  });

  test('block raw matches content slice', () => {
    const content = 'first\n\nsecond';
    const blocks = parseToBlocks(content);
    for (const b of blocks) {
      expect(b.raw).toBe(content.slice(b.startOffset, b.endOffset));
    }
  });

  test('inline markdown in paragraph is preserved as raw', () => {
    const blocks = parseToBlocks('hello **bold** and *italic*');
    blocksOf(['paragraph'], blocks);
    expect(blockAt(blocks, 0).raw).toBe('hello **bold** and *italic*');
  });
});

// ── MarkdownRenderer cache ──

describe('MarkdownRenderer cache', () => {
  test('same content returns cached split', () => {
    const renderer = getMarkdownRenderer();
    const r1 = renderer.render('hello\n\nworld', 8);
    const r2 = renderer.render('hello\n\nworld', 8);
    expect(r1).toBe(r2); // same object reference (cached)
  });

  test('different committedLength returns new split', () => {
    const renderer = getMarkdownRenderer();
    const r1 = renderer.render('hello\n\nworld', 4);
    const r2 = renderer.render('hello\n\nworld', 8);
    expect(r1).not.toBe(r2);
  });

  test('different content triggers reparse', () => {
    const renderer = getMarkdownRenderer();
    const r1 = renderer.render('hello\n\nworld', 8);
    const r2 = renderer.render('bonjour\n\nmonde', 8);
    // Different content → different blocks → different render output
    expect(r1).not.toBe(r2);
  });

  test('no committed content returns empty stable', () => {
    const renderer = getMarkdownRenderer();
    const result = renderer.render('hello world', 0);
    expect(result.stable.length).toBe(0);
  });

  test('fully committed content has no tail', () => {
    const renderer = getMarkdownRenderer();
    const result = renderer.render('# Title\n\n', 10);
    expect(result.tail.length).toBe(0);
  });

  test('reset clears all caches', () => {
    const renderer = getMarkdownRenderer();
    const r1 = renderer.render('hello\n\nworld', 8);
    renderer.reset();
    const r2 = renderer.render('hello\n\nworld', 8);
    expect(r1).not.toBe(r2); // fresh parse after reset
  });
});
