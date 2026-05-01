import { describe, test, expect } from 'bun:test';
import { findStableBoundary } from '../../src/cli/tui-v2/views/active/findStableBoundary';

describe('findStableBoundary', () => {
  test('empty string returns 0', () => {
    expect(findStableBoundary('')).toBe(0);
  });

  test('plain text without newline returns 0 (no stable boundary yet)', () => {
    expect(findStableBoundary('hello world')).toBe(0);
  });

  test('paragraph + double newline + trailing partial text', () => {
    const s = 'hello world.\n\nstill writing';
    expect(findStableBoundary(s)).toBe('hello world.\n\n'.length);
  });

  test('single newline in stable text is not a boundary', () => {
    const s = 'line1\nline2\n\npartial';
    expect(findStableBoundary(s)).toBe('line1\nline2\n\n'.length);
  });

  test('unclosed code fence returns 0', () => {
    const s = '```py\nprint(1)\n';
    expect(findStableBoundary(s)).toBe(0);
  });

  test('closed code fence + trailing text', () => {
    const s = '```py\nprint(1)\n```\n\nok';
    // After the closing ```, the \n\n is a paragraph boundary
    expect(findStableBoundary(s)).toBe('```py\nprint(1)\n```\n\n'.length);
  });

  test('tilde fence is recognized', () => {
    const s = '~~~sh\nls\n~~~\n\ndone.';
    expect(findStableBoundary(s)).toBe('~~~sh\nls\n~~~\n\n'.length);
  });

  test('partial table header without alignment row', () => {
    const s = '| a | b |\n';
    expect(findStableBoundary(s)).toBe(0);
  });

  test('table with alignment row is stable after alignment', () => {
    const s = '| a | b |\n|---|---|\n| 1';
    expect(findStableBoundary(s)).toBe('| a | b |\n|---|---|\n'.length);
  });

  // \n\n (paragraph break) terminates all inline structures in commonmark.
  // An unclosed backtick/bracket/URL inside a paragraph is just literal text
  // and won't affect the next paragraph's parsing.
  test('unclosed backtick before paragraph break is safe', () => {
    const s = 'hello `world\n\nnext para';
    expect(findStableBoundary(s)).toBe('hello `world\n\n'.length);
  });

  test('closed inline code with trailing stable text', () => {
    const s = 'hello `world`.\n\nnext';
    expect(findStableBoundary(s)).toBe('hello `world`.\n\n'.length);
  });

  test('unclosed link bracket before paragraph break is safe', () => {
    const s = 'see [the docs\n\nnext';
    expect(findStableBoundary(s)).toBe('see [the docs\n\n'.length);
  });

  test('unclosed link URL before paragraph break is safe', () => {
    const s = 'see [the docs](http\n\nnext';
    expect(findStableBoundary(s)).toBe('see [the docs](http\n\n'.length);
  });

  test('closed link + trailing paragraph', () => {
    const s = 'see [the docs](http://x.com).\n\nthen';
    expect(findStableBoundary(s)).toBe('see [the docs](http://x.com).\n\n'.length);
  });

  test('trailing backslash escape', () => {
    const s = 'line ending with \\\n';
    expect(findStableBoundary(s)).toBe(0);
  });

  test('double backslash (escaped backslash) is stable', () => {
    const s = 'line ending with \\\\\n\ndone';
    expect(findStableBoundary(s)).toBe('line ending with \\\\\n\n'.length);
  });

  test('math block $$ unclosed returns 0', () => {
    const s = '$$\nx = 1\n';
    expect(findStableBoundary(s)).toBe(0);
  });

  test('math block $$ closed + trailing', () => {
    const s = '$$\nx = 1\n$$\n\nafter math';
    expect(findStableBoundary(s)).toBe('$$\nx = 1\n$$\n\n'.length);
  });
});
