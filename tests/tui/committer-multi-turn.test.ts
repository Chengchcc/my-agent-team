import { describe, test, expect, beforeEach } from 'bun:test';
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
    stats: { promptTokens: 0, completionTokens: 0, contextTokens: 0, tokenLimit: 0, streaming: false, streamingStartTime: null, interrupted: false, compacting: false },
  });
}

describe('Committer multi-turn', () => {
  beforeEach(() => {
    resetStore();
  });

  test('multi-turn: tool calls + final text, onTurnDone finalizes exactly once', async () => {
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

    // The finalized assistant message should have all segments
    const asst = s.finalized[s.finalized.length - 1]!;
    expect(asst.kind).toBe('assistant-message');
    if (asst.kind === 'assistant-message') {
      expect(asst.status).toBe('done');
      // Should have text + 2 tool calls + text
      expect(asst.segments.length).toBe(4);
      expect(asst.segments[0]!.kind).toBe('text');
      expect(asst.segments[1]!.kind).toBe('tool_call');
      expect(asst.segments[2]!.kind).toBe('tool_call');
      expect(asst.segments[3]!.kind).toBe('text');
    }
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
    const asst = s.finalized[s.finalized.length - 1]!;
    if (asst.kind === 'assistant-message') {
      const toolSeg = asst.segments.find(s => s.kind === 'tool_call');
      expect(toolSeg).toBeDefined();
      if (toolSeg?.kind === 'tool_call') {
        expect(toolSeg.result?.kind).toBe('error');
      }
    }
  });

  test('pure text session (no tools): finalized via agent_done-equivalent onTurnDone', async () => {
    const c = getCommitter();
    store().turnStart('a1');
    store().streamingStart();

    c.onDelta('Just a simple answer.\n\nNo tools needed.');
    await new Promise(r => setTimeout(r, 80));
    c.onTurnDone();

    const s = store();
    expect(s.live).toBeNull();
    expect(s.finalized.length).toBe(1);
    const asst = s.finalized[0]!;
    if (asst.kind === 'assistant-message') {
      expect(asst.segments.length).toBe(1);
      if (asst.segments[0]!.kind === 'text') {
        expect(asst.segments[0]!.committedLength).toBe(asst.segments[0]!.content.length);
      }
    }
  });
});
