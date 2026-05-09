import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { getCommitter } from '../../src/cli/tui/streaming/committer';
import { useTuiStore } from '../../src/cli/tui/state/store';

function store() {
  return useTuiStore.getState();
}

function resetStore() {
  useTuiStore.setState({
    finalized: [],
    live: null,
    interaction: { focusedToolId: null, expandedTools: new Set(), ignoredErrors: new Set(), pendingInputs: [] },
    stats: { promptTokens: 0, completionTokens: 0, contextTokens: 0, tokenLimit: 0, streaming: false, streamingStartTime: null, interrupted: false },
  });
}

function liveSeg(idx: number) {
  const live = store().live;
  if (live?.kind !== 'assistant-message') throw new Error('no live assistant');
  return live.segments[idx]!;
}

describe('StreamingCommitter', () => {
  beforeEach(() => {
    resetStore();
  });

  test('onDelta calls store.textDelta to update live content', () => {
    store().turnStart('a1');
    getCommitter().onDelta('Hello');

    const s = store();
    expect(s.live?.kind).toBe('assistant-message');
    if (s.live?.kind === 'assistant-message') {
      expect(s.live.segments).toHaveLength(1);
      expect(s.live.segments[0]!.kind).toBe('text');
      if (s.live.segments[0]!.kind === 'text') {
        expect(s.live.segments[0]!.content).toBe('Hello');
      }
    }
  });

  test('onDelta accumulates content across multiple calls in live', () => {
    store().turnStart('a1');
    const c = getCommitter();
    c.onDelta('Hello');
    c.onDelta(' world');

    expect(liveSeg(0).kind).toBe('text');
    if (liveSeg(0).kind === 'text') {
      expect(liveSeg(0).content).toBe('Hello world');
    }
  });

  test('onTurnDone clears live and finalizes content', () => {
    store().turnStart('a1');
    const c = getCommitter();
    c.onDelta('done.');
    c.onTurnDone();

    const s = store();
    expect(s.live).toBeNull();
    // Should have header + tail
    expect(s.finalized.length).toBeGreaterThanOrEqual(2);
    expect(s.finalized[0]!.kind).toBe('assistant-header');
    expect(s.stats.streaming).toBe(false);
  });

  test('onTurnDone commits all remaining text content', () => {
    store().turnStart('a1');
    const c = getCommitter();
    c.onDelta('full response');
    c.onTurnDone();

    const s = store();
    expect(s.live).toBeNull();
    // All content should be in finalized (header + tail or header + blocks)
    const textContent = s.finalized
      .filter(i => i.kind === 'committed-block' || i.kind === 'assistant-tail')
      .map(i => i.kind === 'committed-block' ? i.raw : i.kind === 'assistant-tail' ? i.raw : '')
      .join('');
    expect(textContent).toContain('full response');
  });

  test('committer pipeline commits stable content at paragraph boundaries', async () => {
    store().turnStart('a1');
    const c = getCommitter();

    c.onDelta('Hello world.\n\nstill writing...');
    await new Promise(r => setTimeout(r, 80));

    const s = store();
    const live = s.live;
    if (live?.kind === 'assistant-message') {
      const seg = live.segments[0]!;
      if (seg.kind === 'text') {
        expect(seg.committedLength).toBe('Hello world.'.length);
        expect(seg.content).toBe('Hello world.\n\nstill writing...');
      }
    }
  });

  test('single block not committed while still growing', async () => {
    store().turnStart('a1');
    const c = getCommitter();

    c.onDelta('```py\nprint(1)\nstill in fence');
    await new Promise(r => setTimeout(r, 80));

    if (liveSeg(0).kind === 'text') {
      // Single block is still growing — not committed yet
      expect(liveSeg(0).committedLength).toBe(0);
    }
  });

  test('committer commits after closed code fence with paragraph break', async () => {
    store().turnStart('a1');
    const c = getCommitter();

    c.onDelta('```py\nprint(1)\n```\n\nafter fence');
    await new Promise(r => setTimeout(r, 80));

    if (liveSeg(0).kind === 'text') {
      expect(liveSeg(0).committedLength).toBe('```py\nprint(1)\n```'.length);
      expect(liveSeg(0).content).toBe('```py\nprint(1)\n```\n\nafter fence');
    }
  });

  test('committedLength is monotonic (never decreases)', async () => {
    store().turnStart('a1');
    const c = getCommitter();

    c.onDelta('first paragraph.\n\n');
    await new Promise(r => setTimeout(r, 80));

    const firstLen = liveSeg(0).kind === 'text' ? liveSeg(0).committedLength : -1;

    c.onDelta('second paragraph.\n\n');
    await new Promise(r => setTimeout(r, 80));

    if (liveSeg(0).kind === 'text') {
      expect(liveSeg(0).committedLength).toBeGreaterThanOrEqual(firstLen);
    }
  });

  test('single-paragraph stays uncommitted until second block forms', async () => {
    store().turnStart('a1');
    const c = getCommitter();

    c.onDelta('just some text without paragraph break');
    await new Promise(r => setTimeout(r, 80));

    if (liveSeg(0).kind === 'text') {
      // Single block is still growing — not committed
      expect(liveSeg(0).committedLength).toBe(0);
    }

    // Second block triggers commit of first
    c.onDelta('\n\nsecond block');
    await new Promise(r => setTimeout(r, 80));

    if (liveSeg(0).kind === 'text') {
      expect(liveSeg(0).committedLength).toBeGreaterThan(0);
    }
  });
});
