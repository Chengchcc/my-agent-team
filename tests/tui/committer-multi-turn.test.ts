import { describe, test, expect, beforeEach } from 'bun:test';
import { getCommitter } from '../../src/extensions/frontend.tui/streaming/committer';
import { useTuiStore } from '../../src/extensions/frontend.tui/state/store';

function store() {
  return useTuiStore.getState();
}

function resetStore() {
  useTuiStore.setState({
    finalized: [],
    live: null,
    interaction: { focusedToolId: null, expandedTools: new Set(), ignoredErrors: new Set(), pendingInputs: [] },
    stats: { lastTurnInputTokens: 0, completionTokens: 0, tokenLimit: 0, streaming: false, streamingStartTime: null, interrupted: false, compacting: false, mode: 'normal' },
  });
}

describe('Committer multi-turn', () => {
  beforeEach(() => {
    resetStore();
  });

  test('multi-turn: tool calls + final text, granular items in finalized', async () => {
    const c = getCommitter();
    store().turnStart('a1');
    store().streamingStart();

    // Turn 0: text + tool calls
    c.onDelta('I will search for files.\n\n');
    store().toolStart('tool1', 'grep', { pattern: 'foo' });
    store().toolStart('tool2', 'ls', { path: '/tmp' });
    await new Promise(r => setTimeout(r, 80));
    // flush after tool results
    store().toolDone('tool1', { kind: 'ok', content: 'result1', durationMs: 10 });
    c.flush();
    store().toolDone('tool2', { kind: 'ok', content: 'result2', durationMs: 5 });
    c.flush();

    // Turn 1: final text (no more tools)
    c.onDelta('Found 2 files.\n\nDone.');
    await new Promise(r => setTimeout(r, 80));

    // Finalize
    c.onTurnDone();

    const s = store();
    expect(s.live).toBeNull();
    expect(s.finalized.length).toBeGreaterThanOrEqual(1);

    // Should have granular items: header, committed-block(s), tool-call-final(s), tail
    const kinds = s.finalized.map(i => i.kind);
    expect(kinds).toContain('assistant-header');
    // Tool calls should be tool-call-final items
    const toolFinals = s.finalized.filter(i => i.kind === 'tool-call-final');
    expect(toolFinals.length).toBe(2);
  });

  test('onTurnDone is idempotent (second call is no-op)', async () => {
    const c = getCommitter();
    store().turnStart('a1');
    store().streamingStart();
    c.onDelta('response text');
    await new Promise(r => setTimeout(r, 80));

    c.onTurnDone();
    const finalizedLen1 = store().finalized.length;
    const live1 = store().live;

    c.onTurnDone();
    const finalizedLen2 = store().finalized.length;
    const live2 = store().live;

    expect(live1).toBeNull();
    expect(live2).toBeNull();
    expect(finalizedLen2).toBe(finalizedLen1);
  });

  test('multi-turn with tool errors: error results are preserved', async () => {
    const c = getCommitter();
    store().turnStart('a1');
    store().streamingStart();

    c.onDelta('Let me check.');
    store().toolStart('bad', 'read', { path: '/nonexistent' });
    await new Promise(r => setTimeout(r, 80));
    store().toolDone('bad', { kind: 'error', message: 'ENOENT', durationMs: 3 });
    c.flush();

    c.onDelta('\n\nFile not found.');
    await new Promise(r => setTimeout(r, 80));
    c.onTurnDone();

    const s = store();
    expect(s.live).toBeNull();
    // Error tool should be in tool-call-final
    const errorTool = s.finalized.find(i => i.kind === 'tool-call-final');
    expect(errorTool).toBeDefined();
    if (errorTool!.kind === 'tool-call-final') {
      expect(errorTool!.result.kind).toBe('error');
    }
  });

  test('pure text session (no tools): granular items via onTurnDone', async () => {
    const c = getCommitter();
    store().turnStart('a1');
    store().streamingStart();

    c.onDelta('Just a simple answer.\n\nNo tools needed.');
    await new Promise(r => setTimeout(r, 80));
    c.onTurnDone();

    const s = store();
    expect(s.live).toBeNull();
    // Should have header + committed-blocks + tail
    const kinds = s.finalized.map(i => i.kind);
    expect(kinds).toContain('assistant-header');
    // All text content should be captured in committed-blocks and/or tail
    const textContent = s.finalized
      .filter(i => i.kind === 'committed-block' || i.kind === 'assistant-tail')
      .map(i => i.kind === 'committed-block' ? i.raw : i.kind === 'assistant-tail' ? i.raw : '')
      .join('');
    expect(textContent).toContain('Just a simple answer.');
  });
});
