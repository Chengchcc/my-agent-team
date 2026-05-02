import { describe, test, expect } from 'bun:test';
import { parseDoc, type Block } from '../../src/cli/tui/markdown/parse-ast';
import { getMarkdownRenderer } from '../../src/cli/tui/markdown/cache';
import type { Definition, FootnoteDefinition } from 'mdast';
import type { Heading, Code, List, ListItem, Table } from 'mdast';

function typesOf(blocks: Block[]): string[] {
  return blocks.map(b => b.node.type);
}

function blockAt(blocks: Block[], index: number): Block {
  const b = blocks[index];
  if (!b) throw new Error(`No block at index ${index}`);
  return b;
}

function nodeAt(blocks: Block[], index: number) {
  return blockAt(blocks, index).node;
}

// ── parseDoc (mdast-based) ──

describe('parseDoc', () => {
  test('empty string returns empty doc', () => {
    const doc = parseDoc('');
    expect(doc.blocks).toEqual([]);
    expect(doc.definitions.size).toBe(0);
    expect(doc.footnotes.size).toBe(0);
  });

  test('single paragraph', () => {
    const doc = parseDoc('hello world');
    expect(typesOf(doc.blocks)).toEqual(['paragraph']);
    expect(blockAt(doc.blocks, 0).raw).toBe('hello world');
  });

  // ── Headings ──

  test('atx heading h1', () => {
    const { blocks } = parseDoc('# Hello');
    expect(typesOf(blocks)).toEqual(['heading']);
    expect((nodeAt(blocks, 0) as Heading).depth).toBe(1);
    expect(blockAt(blocks, 0).raw).toBe('# Hello');
  });

  test('atx heading h3', () => {
    const { blocks } = parseDoc('### Deep');
    expect(typesOf(blocks)).toEqual(['heading']);
    expect((nodeAt(blocks, 0) as Heading).depth).toBe(3);
  });

  test('atx heading h6', () => {
    const { blocks } = parseDoc('###### Small');
    expect((nodeAt(blocks, 0) as Heading).depth).toBe(6);
  });

  test('setext heading H1', () => {
    const { blocks } = parseDoc('Title\n=====');
    expect(typesOf(blocks)).toEqual(['heading']);
    expect((nodeAt(blocks, 0) as Heading).depth).toBe(1);
  });

  test('setext heading H2', () => {
    const { blocks } = parseDoc('Sub\n---');
    expect(typesOf(blocks)).toEqual(['heading']);
    expect((nodeAt(blocks, 0) as Heading).depth).toBe(2);
  });

  test('heading followed by paragraph', () => {
    const { blocks } = parseDoc('# Title\n\nbody text');
    expect(typesOf(blocks)).toEqual(['heading', 'paragraph']);
  });

  // ── Code blocks ──

  test('fenced code block with language', () => {
    const { blocks } = parseDoc('```js\nconst x = 1;\n```');
    expect(typesOf(blocks)).toEqual(['code']);
    expect((nodeAt(blocks, 0) as Code).lang).toBe('js');
  });

  test('fenced code without language', () => {
    const { blocks } = parseDoc('```\nline\n```');
    expect(typesOf(blocks)).toEqual(['code']);
    expect((nodeAt(blocks, 0) as Code).lang).toBeNull();
  });

  test('tilde fenced code', () => {
    const { blocks } = parseDoc('~~~py\nprint(1)\n~~~');
    expect(typesOf(blocks)).toEqual(['code']);
    expect((nodeAt(blocks, 0) as Code).lang).toBe('py');
  });

  test('indented code', () => {
    const { blocks } = parseDoc('    indented line');
    expect(typesOf(blocks)).toEqual(['code']);
  });

  // ── Lists ──

  test('unordered list produces list block with listItems', () => {
    const { blocks } = parseDoc('- item 1\n- item 2');
    expect(typesOf(blocks)).toEqual(['list']);
    const list = nodeAt(blocks, 0) as List;
    expect(list.ordered).toBe(false);
    expect(list.children).toHaveLength(2);
  });

  test('ordered list produces list block with listItems', () => {
    const { blocks } = parseDoc('1. first\n2. second');
    expect(typesOf(blocks)).toEqual(['list']);
    const list = nodeAt(blocks, 0) as List;
    expect(list.ordered).toBe(true);
    expect(list.start).toBe(1);
    expect(list.children).toHaveLength(2);
  });

  test('ordered list with custom start', () => {
    const { blocks } = parseDoc('5. fifth\n6. sixth');
    const list = nodeAt(blocks, 0) as List;
    expect(list.start).toBe(5);
  });

  test('task list items have checked state', () => {
    const { blocks } = parseDoc('- [ ] todo\n- [x] done');
    const list = nodeAt(blocks, 0) as List;
    expect((list.children[0] as ListItem).checked).toBe(false);
    expect((list.children[1] as ListItem).checked).toBe(true);
  });

  // ── Blockquotes ──

  test('blockquote single line', () => {
    const { blocks } = parseDoc('> quoted');
    expect(typesOf(blocks)).toEqual(['blockquote']);
  });

  // ── Thematic break ──

  test('thematic break (dashes)', () => {
    const { blocks } = parseDoc('---');
    expect(typesOf(blocks)).toEqual(['thematicBreak']);
  });

  test('thematic break (asterisks)', () => {
    const { blocks } = parseDoc('***');
    expect(typesOf(blocks)).toEqual(['thematicBreak']);
  });

  // ── Tables ──

  test('GFM table produces table block', () => {
    const { blocks } = parseDoc('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(typesOf(blocks)).toEqual(['table']);
    const table = nodeAt(blocks, 0) as Table;
    expect(table.children).toHaveLength(2);
    expect(table.align).toEqual([null, null]);
  });

  test('table with alignment', () => {
    const { blocks } = parseDoc('| left | center | right |\n|:---|:---:|---:|\n| a | b | c |');
    const table = nodeAt(blocks, 0) as Table;
    expect(table.align).toEqual(['left', 'center', 'right']);
  });

  test('table with multiple body rows', () => {
    const { blocks } = parseDoc('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |');
    const table = nodeAt(blocks, 0) as Table;
    expect(table.children).toHaveLength(3);
  });

  test('table with inline formatting in cells', () => {
    const { blocks } = parseDoc('| **bold** | `code` |\n|---|---|\n| *italic* | x |');
    expect(typesOf(blocks)).toEqual(['table']);
  });

  // ── HTML ──

  test('HTML flow produces html block', () => {
    const { blocks } = parseDoc('<div>\nhi\n</div>');
    expect(typesOf(blocks)).toEqual(['html']);
  });

  // ── Definitions ──

  test('link definition goes to definitions map, not blocks', () => {
    const doc = parseDoc('[label]: /url "title"');
    expect(doc.blocks).toEqual([]);
    expect(doc.definitions.size).toBe(1);
    expect(doc.definitions.get('label')?.url).toBe('/url');
  });

  test('footnote definition goes to footnotes map, not blocks', () => {
    const doc = parseDoc('[^1]: footnote text');
    expect(doc.blocks).toEqual([]);
    expect(doc.footnotes.size).toBe(1);
    expect(doc.footnotes.get('1')?.children).toHaveLength(1);
  });

  test('link reference with definition resolves URL', () => {
    const doc = parseDoc('[text][ref]\n\n[ref]: https://example.com');
    expect(typesOf(doc.blocks)).toEqual(['paragraph']);
    expect(doc.definitions.get('ref')?.url).toBe('https://example.com');
  });

  test('footnote reference and definition are paired', () => {
    const doc = parseDoc('Some text[^1]\n\n[^1]: A footnote.');
    expect(typesOf(doc.blocks)).toEqual(['paragraph']);
    expect(doc.footnotes.size).toBe(1);
  });

  // ── Multiple blocks & offsets ──

  test('multiple paragraphs', () => {
    const { blocks } = parseDoc('first\n\nsecond');
    expect(typesOf(blocks)).toEqual(['paragraph', 'paragraph']);
    expect(blockAt(blocks, 0).raw).toBe('first');
    expect(blockAt(blocks, 1).raw).toBe('second');
  });

  test('block offsets are correct', () => {
    const content = 'aaa\n\nbbb';
    const { blocks } = parseDoc(content);
    expect(blockAt(blocks, 0).startOffset).toBe(0);
    expect(blockAt(blocks, 0).endOffset).toBe(3);
    expect(blockAt(blocks, 1).startOffset).toBe(5);
    expect(blockAt(blocks, 1).endOffset).toBe(8);
  });

  test('block raw matches content slice', () => {
    const content = 'first\n\nsecond';
    const { blocks } = parseDoc(content);
    for (const b of blocks) {
      expect(b.raw).toBe(content.slice(b.startOffset, b.endOffset));
    }
  });

  test('inline markdown in paragraph preserved in raw', () => {
    const { blocks } = parseDoc('hello **bold** and *italic*');
    expect(typesOf(blocks)).toEqual(['paragraph']);
    expect(blockAt(blocks, 0).raw).toBe('hello **bold** and *italic*');
  });
});

// ── MarkdownRenderer (stateless rendering) ──

describe('MarkdownRenderer render', () => {
  const W = 80;

  function render(content: string, committedLength: number) {
    const doc = parseDoc(content);
    return getMarkdownRenderer().render(
      content, committedLength, W,
      doc.blocks, doc.definitions, doc.footnotes,
    );
  }

  test('no committed content returns empty stable', () => {
    const result = render('hello world', 0);
    expect(result.stable.length).toBe(0);
  });

  test('fully committed content has no tail', () => {
    const doc = parseDoc('# Title\n\n');
    // Heading is at endOffset=7. With committedLength = content.length, all blocks in stable.
    const result = render('# Title\n\n', '# Title\n\n'.length);
    expect(result.tail.length).toBe(0);
  });

  test('partially committed: committed blocks go to stable, uncommitted to tail', () => {
    const result = render('hello\n\nworld', 5);
    // First paragraph only → stable; second → tail
    expect(result.stable.length).toBe(1);
    expect(result.tail.length).toBeGreaterThan(0);
  });

  test('renderer is stateless — same inputs produce different object refs', () => {
    const r1 = render('hello\n\nworld', 8);
    const r2 = render('hello\n\nworld', 8);
    // Stateless — no object identity caching
    expect(r1).not.toBe(r2);
    // But result structure is equivalent
    expect(r1.stable.length).toBe(r2.stable.length);
    expect(r1.tail.length).toBe(r2.tail.length);
  });

  test('reset is a no-op (renderer is stateless)', () => {
    getMarkdownRenderer().reset();
    // Should not throw
    expect(true).toBe(true);
  });

  test('plain text with no blocks renders in tail', () => {
    // A single character that forms no blocks
    const result = render('a', 0);
    // 0 blocks, committedLength < content.length → raw tail
    expect(result.tail.length).toBeGreaterThan(0);
  });
});
