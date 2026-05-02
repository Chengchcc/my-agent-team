import { describe, test, expect } from 'bun:test';
import { findStableBoundary } from '../../src/cli/tui/streaming/findStableBoundary';

function b(s: string): number {
  return findStableBoundary(s).boundary;
}

describe('findStableBoundary', () => {
  test('empty string returns 0', () => {
    expect(b('')).toBe(0);
  });

  test('plain text without newline returns 0 (no stable boundary yet)', () => {
    expect(b('hello world')).toBe(0);
  });

  test('paragraph + double newline + trailing partial text', () => {
    const s = 'hello world.\n\nstill writing';
    expect(b(s)).toBe('hello world.\n\n'.length);
  });

  test('single newline in stable text is not a boundary', () => {
    const s = 'line1\nline2\n\npartial';
    expect(b(s)).toBe('line1\nline2\n\n'.length);
  });

  test('unclosed code fence returns 0', () => {
    const s = '```py\nprint(1)\n';
    expect(b(s)).toBe(0);
  });

  test('closed code fence + trailing text', () => {
    const s = '```py\nprint(1)\n```\n\nok';
    expect(b(s)).toBe('```py\nprint(1)\n```\n\n'.length);
  });

  test('tilde fence is recognized', () => {
    const s = '~~~sh\nls\n~~~\n\ndone.';
    expect(b(s)).toBe('~~~sh\nls\n~~~\n\n'.length);
  });

  test('partial table header without alignment row (micromark: paragraph)', () => {
    const s = '| a | b |\n';
    // micromark treats lone pipe rows as paragraph text — no GFM table without alignment row
    expect(b(s)).toBe(9);
  });

  test('table with alignment row is stable after alignment', () => {
    const s = '| a | b |\n|---|---|\n| 1';
    expect(b(s)).toBe('| a | b |\n|---|---|\n'.length);
  });

  test('unclosed backtick before paragraph break is safe', () => {
    const s = 'hello `world\n\nnext para';
    expect(b(s)).toBe('hello `world\n\n'.length);
  });

  test('closed inline code with trailing stable text', () => {
    const s = 'hello `world`.\n\nnext';
    expect(b(s)).toBe('hello `world`.\n\n'.length);
  });

  test('unclosed link bracket before paragraph break is safe', () => {
    const s = 'see [the docs\n\nnext';
    expect(b(s)).toBe('see [the docs\n\n'.length);
  });

  test('unclosed link URL before paragraph break is safe', () => {
    const s = 'see [the docs](http\n\nnext';
    expect(b(s)).toBe('see [the docs](http\n\n'.length);
  });

  test('closed link + trailing paragraph', () => {
    const s = 'see [the docs](http://x.com).\n\nthen';
    expect(b(s)).toBe('see [the docs](http://x.com).\n\n'.length);
  });

  test('trailing backslash escape (micromark: hard break in paragraph)', () => {
    const s = 'line ending with \\\n';
    // micromark treats trailing \\\n as a hard line break within a completed paragraph
    expect(b(s)).toBe(18);
  });

  test('double backslash (escaped backslash) is stable', () => {
    const s = 'line ending with \\\\\n\ndone';
    expect(b(s)).toBe('line ending with \\\\\n\n'.length);
  });

  test('math block $$ unclosed (micromark: no math extension, treated as text)', () => {
    const s = '$$\nx = 1\n';
    // micromark has no math extension — $$ is just paragraph text
    expect(b(s)).toBe(8);
  });

  test('math block $$ closed + trailing', () => {
    const s = '$$\nx = 1\n$$\n\nafter math';
    expect(b(s)).toBe('$$\nx = 1\n$$\n\n'.length);
  });

  // ── committable flag tests ──

  test('empty string is not committable', () => {
    expect(findStableBoundary('').committable).toBe(false);
  });

  test('complete heading is committable', () => {
    expect(findStableBoundary('# Hello\n\n').committable).toBe(true);
  });

  test('closed fence is committable', () => {
    expect(findStableBoundary('```py\nprint(1)\n```\n\n').committable).toBe(true);
  });

  test('bare text without double newline is not committable', () => {
    expect(findStableBoundary('hello').committable).toBe(false);
  });

  test('paragraph ending with double newline is committable', () => {
    expect(findStableBoundary('hello world.\n\n').committable).toBe(true);
  });
});
