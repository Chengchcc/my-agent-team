import { describe, test, expect, beforeEach } from 'bun:test';
import { useTuiStore, resetNextId } from '../../src/cli/tui/state/store';

function store() {
  return useTuiStore.getState();
}

function resetStore() {
  resetNextId();
  useTuiStore.setState({
    finalized: [],
    live: null,
    interaction: { focusedToolId: null, expandedTools: new Set(), ignoredErrors: new Set(), pendingInputs: [] },
    stats: { promptTokens: 0, completionTokens: 0, contextTokens: 0, tokenLimit: 0, streaming: false, streamingStartTime: null, interrupted: false },
    reviewNotifications: [],
  });
}

describe('turn lifecycle (core 6 actions)', () => {
  beforeEach(resetStore);

  test('turnStart creates streaming assistant-message in live', () => {
    store().userSubmit('u1', 'hello');
    store().turnStart('a1');
    const s = store();
    // finalized only has the user message
    expect(s.finalized).toHaveLength(1);
    expect(s.finalized[0]).toEqual({ kind: 'user-message', id: 'u1', content: 'hello' });
    // live holds the streaming assistant
    expect(s.live).toEqual({ kind: 'assistant-message', id: 'a1', segments: [], status: 'streaming' });
  });

  test('textDelta appends and merges text segments in live', () => {
    store().turnStart('a1');
    store().textDelta('Hello');
    store().textDelta(' world');
    const s = store();
    expect(s.live?.kind).toBe('assistant-message');
    if (s.live?.kind === 'assistant-message') {
      expect(s.live.segments).toHaveLength(1);
      expect(s.live.segments[0]).toEqual({ kind: 'text', id: expect.any(String), content: 'Hello world', committedLength: 0 });
    }
  });

  test('toolStart and toolDone interleave with text in live', () => {
    store().turnStart('a1');
    store().textDelta('Let me ');
    store().toolStart('t1', 'read', { path: 'f.ts' });
    store().toolDone('t1', { kind: 'ok', content: '...', durationMs: 42 });
    store().textDelta('done.');

    const s = store();
    expect(s.live?.kind).toBe('assistant-message');
    if (s.live?.kind === 'assistant-message') {
      expect(s.live.segments).toHaveLength(3);
      expect(s.live.segments[0]).toEqual({ kind: 'text', id: expect.any(String), content: 'Let me ', committedLength: 0 });
      expect(s.live.segments[1]).toMatchObject({ kind: 'tool_call', id: 't1', name: 'read', input: { path: 'f.ts' } });
      const tc = s.live.segments[1]!;
      if (tc.kind === 'tool_call') {
        expect(tc.result).toEqual({ kind: 'ok', content: '...', durationMs: 42 });
      }
      expect(s.live.segments[2]).toEqual({ kind: 'text', id: expect.any(String), content: 'done.', committedLength: 0 });
    }
  });

  test('turnDone moves live to finalized and clears live', () => {
    store().turnStart('a1');
    store().textDelta('response');
    store().turnDone();

    const s = store();
    // live is cleared
    expect(s.live).toBeNull();
    // finalized has the done assistant-message
    expect(s.finalized).toHaveLength(1);
    const asst = s.finalized[0]!;
    expect(asst.kind).toBe('assistant-message');
    if (asst.kind === 'assistant-message') {
      expect(asst.status).toBe('done');
      expect(asst.segments[0]).toMatchObject({ kind: 'text', content: 'response', committedLength: 'response'.length });
    }
  });

  test('commitAdvance increments committedLength on live text segment', () => {
    store().turnStart('a1');
    store().textDelta('hello world');
    const s = store();
    const segId = (s.live?.kind === 'assistant-message' && s.live.segments[0]?.kind === 'text') ? s.live.segments[0].id : '';
    expect(segId).toBeTruthy();

    store().commitAdvance(segId, 5);
    const updated = store();
    if (updated.live?.kind === 'assistant-message' && updated.live.segments[0]?.kind === 'text') {
      expect(updated.live.segments[0].committedLength).toBe(5);
    }
  });

  test('commitAdvance is monotonic (never decreases)', () => {
    store().turnStart('a1');
    store().textDelta('hello world');
    const s = store();
    const segId = (s.live?.kind === 'assistant-message' && s.live.segments[0]?.kind === 'text') ? s.live.segments[0].id : '';

    store().commitAdvance(segId, 5);
    store().commitAdvance(segId, 3); // should be ignored
    const updated = store();
    if (updated.live?.kind === 'assistant-message' && updated.live.segments[0]?.kind === 'text') {
      expect(updated.live.segments[0].committedLength).toBe(5);
    }
  });
});

describe('auxiliary actions', () => {
  beforeEach(resetStore);

  test('userSubmit adds user-message to finalized', () => {
    store().userSubmit('u1', 'hello');
    expect(store().finalized).toEqual([{ kind: 'user-message', id: 'u1', content: 'hello' }]);
  });

  test('appendDivider adds divider', () => {
    store().appendDivider('clear');
    expect(store().finalized).toEqual([{ kind: 'divider', reason: 'clear' }]);
  });

  test('appendSystemNotice adds system-notice', () => {
    store().appendSystemNotice('n1', 'Saved session');
    expect(store().finalized).toEqual([{ kind: 'system-notice', id: 'n1', content: 'Saved session' }]);
  });

  test('clearActive clears live and stops streaming', () => {
    store().turnStart('a1');
    store().streamingStart();
    store().clearActive();
    expect(store().live).toBeNull();
    expect(store().stats.streaming).toBe(false);
  });
});

describe('interaction actions', () => {
  beforeEach(resetStore);

  test('enqueue / dequeue pending inputs', () => {
    store().enqueuePendingInput('a');
    store().enqueuePendingInput('b');
    expect(store().interaction.pendingInputs).toEqual(['a', 'b']);
    store().dequeuePendingInput();
    expect(store().interaction.pendingInputs).toEqual(['b']);
  });

  test('clearPendingInputs removes all', () => {
    store().enqueuePendingInput('a');
    store().enqueuePendingInput('b');
    store().clearPendingInputs();
    expect(store().interaction.pendingInputs).toEqual([]);
  });

  test('moveFocus cycles through tool ids', () => {
    store().moveFocus(1, ['t1', 't2']);
    expect(store().interaction.focusedToolId).toBe('t1');
    store().moveFocus(1, ['t1', 't2']);
    expect(store().interaction.focusedToolId).toBe('t2');
    store().moveFocus(1, ['t1', 't2']);
    expect(store().interaction.focusedToolId).toBe('t1');
  });

  test('moveFocus with empty list clears focus', () => {
    store().focusTool('t1');
    store().moveFocus(1, []);
    expect(store().interaction.focusedToolId).toBeNull();
  });

  test('focusTool sets and clears focus', () => {
    store().focusTool('t1');
    expect(store().interaction.focusedToolId).toBe('t1');
    store().focusTool(null);
    expect(store().interaction.focusedToolId).toBeNull();
  });

  test('toggleExpanded toggles expanded set', () => {
    store().focusTool('t1');
    store().toggleExpanded();
    expect(store().interaction.expandedTools.has('t1')).toBe(true);
    store().toggleExpanded();
    expect(store().interaction.expandedTools.has('t1')).toBe(false);
  });

  test('ignoreError adds to ignoredErrors set', () => {
    store().ignoreError('t1');
    expect(store().interaction.ignoredErrors.has('t1')).toBe(true);
  });
});

describe('stats actions', () => {
  beforeEach(resetStore);

  test('streamingStart sets streaming and startTime', () => {
    store().streamingStart();
    const s = store();
    expect(s.stats.streaming).toBe(true);
    expect(s.stats.streamingStartTime).toBeGreaterThan(0);
    expect(s.stats.interrupted).toBe(false);
  });

  test('streamingStop clears streaming', () => {
    store().streamingStart();
    store().streamingStop();
    expect(store().stats.streaming).toBe(false);
    expect(store().stats.streamingStartTime).toBeNull();
  });

  test('accumulateUsage snapshots prompt and accumulates completion', () => {
    store().accumulateUsage({ prompt_tokens: 100, completion_tokens: 50 });
    expect(store().stats.promptTokens).toBe(100);
    expect(store().stats.completionTokens).toBe(50);

    store().accumulateUsage({ prompt_tokens: 80, completion_tokens: 40 });
    expect(store().stats.promptTokens).toBe(80);
    expect(store().stats.completionTokens).toBe(90);
  });

  test('setInterrupted sets interrupted flag', () => {
    store().setInterrupted(true);
    expect(store().stats.interrupted).toBe(true);
  });
});

describe('resetFromMessages (resume path)', () => {
  beforeEach(resetStore);

  test('converts messages to finalized items with status done, clears live', () => {
    store().turnStart('old-live');
    // resetFromMessages should clear live
    store().resetFromMessages([
      { role: 'user', id: 'u1', content: 'hello' },
      { role: 'assistant', id: 'a1', content: '', blocks: [
        { type: 'text', text: 'hi there' },
        { type: 'tool_use', id: 't1', name: 'read', input: {} },
      ] },
      { role: 'tool', content: 'file ok', tool_call_id: 't1' },
    ]);

    const s = store();
    expect(s.live).toBeNull();
    expect(s.finalized).toHaveLength(2);
    expect(s.finalized[0]).toEqual({ kind: 'user-message', id: 'u1', content: 'hello' });
    const am = s.finalized[1]!;
    expect(am.kind).toBe('assistant-message');
    if (am.kind === 'assistant-message') {
      expect(am.status).toBe('done');
      expect(am.segments).toHaveLength(2);
      expect(am.segments[0]).toMatchObject({ kind: 'text', content: 'hi there' });
      if (am.segments[0]?.kind === 'text') {
        expect(am.segments[0].committedLength).toBe('hi there'.length);
      }
      const tc = am.segments[1]!;
      expect(tc.kind).toBe('tool_call');
      if (tc.kind === 'tool_call') {
        expect(tc.result).toEqual({ kind: 'ok', content: 'file ok', durationMs: 0 });
      }
    }
  });

  test('skips system and tool (orphan) messages', () => {
    store().resetFromMessages([
      { role: 'system', content: 'instructions' },
      { role: 'user', id: 'u1', content: 'hi' },
      { role: 'tool', content: 'result', tool_call_id: 'orphan' },
    ]);
    expect(store().finalized).toHaveLength(1);
    expect(store().finalized[0]!.kind).toBe('user-message');
  });

  test('handles tool error results', () => {
    store().resetFromMessages([
      { role: 'assistant', id: 'a1', content: '', blocks: [
        { type: 'tool_use', id: 't1', name: 'bash', input: {} },
      ] },
      { role: 'tool', content: 'permission denied', tool_call_id: 't1', name: 'error' },
    ]);
    const am = store().finalized[0]!;
    if (am.kind === 'assistant-message') {
      const tc = am.segments[0]!;
      if (tc.kind === 'tool_call') {
        expect(tc.result).toEqual({ kind: 'error', message: 'permission denied', durationMs: 0 });
      }
    }
  });
});

describe('selectors', () => {
  beforeEach(resetStore);

  test('useLiveItem returns live streaming assistant', () => {
    store().turnStart('a1');
    store().textDelta('streaming...');

    const s = store();
    expect(s.live?.kind).toBe('assistant-message');
    if (s.live?.kind === 'assistant-message') {
      expect(s.live.status).toBe('streaming');
      expect(s.live.segments).toHaveLength(1);
    }
    // finalized should be empty (streaming item is not in finalized)
    expect(s.finalized).toHaveLength(0);
  });

  test('turnDone moves item to finalized and clears live', () => {
    store().userSubmit('u1', 'first');
    store().turnStart('a1');
    store().textDelta('ok');
    store().turnDone();

    // Second turn
    store().userSubmit('u2', 'second');
    store().turnStart('a2');
    store().textDelta('in progress...');

    const s = store();
    // finalized has user1 + assistant1 + user2
    expect(s.finalized).toHaveLength(3);
    expect(s.finalized[0]!.kind).toBe('user-message');
    expect(s.finalized[1]!.kind).toBe('assistant-message');
    if (s.finalized[1]!.kind === 'assistant-message') {
      expect(s.finalized[1]!.status).toBe('done');
    }
    expect(s.finalized[2]!.kind).toBe('user-message');
    // live has the current streaming assistant
    expect(s.live?.kind).toBe('assistant-message');
    if (s.live?.kind === 'assistant-message') {
      expect(s.live.status).toBe('streaming');
    }
  });
});
