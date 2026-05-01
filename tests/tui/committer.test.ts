import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { getCommitter } from '../../src/cli/tui/streaming/committer';
import { useTuiStore } from '../../src/cli/tui/state/store';

// Reset store between tests
function resetStore() {
  useTuiStore.setState({
    finalized: [],
    interaction: { focusedToolId: null, expandedTools: new Set(), ignoredErrors: new Set(), pendingInputs: [] },
    stats: { promptTokens: 0, completionTokens: 0, totalTokens: 0, contextTokens: 0, streaming: false, streamingStartTime: null, interrupted: false, tokenLimit: 0 },
  });
}

describe('StreamingCommitter', () => {
  beforeEach(() => {
    resetStore();
  });

  test('onDelta calls store.textDelta to update content', () => {
    useTuiStore.getState().turnStart('a1');
    getCommitter().onDelta('Hello');

    const last = useTuiStore.getState().finalized[0]!;
    expect(last.kind).toBe('assistant-message');
    if (last.kind === 'assistant-message') {
      expect(last.segments).toHaveLength(1);
      expect(last.segments[0]!.kind).toBe('text');
      if (last.segments[0]!.kind === 'text') {
        expect(last.segments[0]!.content).toBe('Hello');
      }
    }
  });

  test('onDelta accumulates content across multiple calls', () => {
    useTuiStore.getState().turnStart('a1');
    const c = getCommitter();
    c.onDelta('Hello');
    c.onDelta(' world');

    const last = useTuiStore.getState().finalized[0]!;
    if (last.kind === 'assistant-message') {
      const seg = last.segments[0]!;
      if (seg.kind === 'text') {
        expect(seg.content).toBe('Hello world');
      }
    }
  });

  test('onTurnDone finalizes the streaming assistant message', () => {
    useTuiStore.getState().turnStart('a1');
    const c = getCommitter();
    c.onDelta('done.');
    c.onTurnDone();

    const last = useTuiStore.getState().finalized[0]!;
    expect(last.kind).toBe('assistant-message');
    if (last.kind === 'assistant-message') {
      expect(last.status).toBe('done');
    }
    expect(useTuiStore.getState().stats.streaming).toBe(false);
  });

  test('onTurnDone commits all remaining text content', () => {
    useTuiStore.getState().turnStart('a1');
    const c = getCommitter();
    c.onDelta('full response');
    c.onTurnDone();

    const last = useTuiStore.getState().finalized[0]!;
    if (last.kind === 'assistant-message') {
      const seg = last.segments[0]!;
      if (seg.kind === 'text') {
        expect(seg.committedLength).toBe(seg.content.length);
      }
    }
  });

  test('committer pipeline commits stable content at paragraph boundaries', async () => {
    useTuiStore.getState().turnStart('a1');
    const c = getCommitter();

    // Feed content that should become committable (paragraph + double newline)
    c.onDelta('Hello world.\n\nstill writing...');

    // Wait for throttle (33ms + buffer)
    await new Promise(r => setTimeout(r, 80));

    const last = useTuiStore.getState().finalized[0]!;
    if (last.kind === 'assistant-message') {
      const seg = last.segments[0]!;
      if (seg.kind === 'text') {
        // The first paragraph should be committed
        expect(seg.committedLength).toBe('Hello world.\n\n'.length);
        expect(seg.content).toBe('Hello world.\n\nstill writing...');
      }
    }
  });

  test('committer does not commit unclosed code fences', async () => {
    useTuiStore.getState().turnStart('a1');
    const c = getCommitter();

    c.onDelta('```py\nprint(1)\nstill in fence');

    await new Promise(r => setTimeout(r, 80));

    const last = useTuiStore.getState().finalized[0]!;
    if (last.kind === 'assistant-message') {
      const seg = last.segments[0]!;
      if (seg.kind === 'text') {
        expect(seg.committedLength).toBe(0);
      }
    }
  });

  test('committer commits after closed code fence with paragraph break', async () => {
    useTuiStore.getState().turnStart('a1');
    const c = getCommitter();

    c.onDelta('```py\nprint(1)\n```\n\nafter fence');

    await new Promise(r => setTimeout(r, 80));

    const last = useTuiStore.getState().finalized[0]!;
    if (last.kind === 'assistant-message') {
      const seg = last.segments[0]!;
      if (seg.kind === 'text') {
        expect(seg.committedLength).toBe('```py\nprint(1)\n```\n\n'.length);
        expect(seg.content).toBe('```py\nprint(1)\n```\n\nafter fence');
      }
    }
  });

  test('committedLength is monotonic (never decreases)', async () => {
    useTuiStore.getState().turnStart('a1');
    const c = getCommitter();

    c.onDelta('first paragraph.\n\n');
    await new Promise(r => setTimeout(r, 80));

    const item1 = useTuiStore.getState().finalized[0]!;
    if (item1.kind !== 'assistant-message') throw new Error('expected assistant-message');
    const seg1 = item1.segments[0]!;
    if (seg1.kind === 'text') {
      const firstLen = seg1.committedLength;

      c.onDelta('second paragraph.\n\n');
      await new Promise(r => setTimeout(r, 80));

      const item2 = useTuiStore.getState().finalized[0]!;
      if (item2.kind !== 'assistant-message') throw new Error('expected assistant-message');
      const seg2 = item2.segments[0]!;
      if (seg2.kind === 'text') {
        expect(seg2.committedLength).toBeGreaterThanOrEqual(firstLen);
      }
    }
  });

  test('non-committable content keeps committedLength at 0', async () => {
    useTuiStore.getState().turnStart('a1');
    const c = getCommitter();

    c.onDelta('just some text without paragraph break');

    await new Promise(r => setTimeout(r, 80));

    const last = useTuiStore.getState().finalized[0]!;
    if (last.kind === 'assistant-message') {
      const seg = last.segments[0]!;
      if (seg.kind === 'text') {
        // Single line without \n\n is not committable
        expect(seg.committedLength).toBe(0);
      }
    }
  });
});
