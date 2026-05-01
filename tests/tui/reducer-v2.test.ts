import { describe, test, expect } from 'bun:test';
import { finalizedReducer, pushFinalizedAssistant } from '../../src/cli/tui/state/finalized-reducer';
import { activeReducer, activeToSegments } from '../../src/cli/tui/state/active-reducer';
import { interactionReducer } from '../../src/cli/tui/state/interaction-reducer';
import { statsReducer } from '../../src/cli/tui/state/stats-reducer';
import { uiReducer, initialUIState } from '../../src/cli/tui/state/dispatch';
import type { FinalItem, ActiveState, InteractionState, StatsState } from '../../src/cli/tui/state/types';

describe('finalizedReducer', () => {
  test('USER_SUBMIT immediately adds user message', () => {
    const items = finalizedReducer([], { type: 'USER_SUBMIT', id: 'u1', content: 'hello' });
    expect(items).toEqual([{ kind: 'user-message', id: 'u1', content: 'hello' }]);
  });

  test('APPEND_DIVIDER adds a clear divider', () => {
    const items = finalizedReducer([], { type: 'APPEND_DIVIDER', reason: 'clear' });
    expect(items).toEqual([{ kind: 'divider', reason: 'clear' }]);
  });

  test('pushFinalizedAssistant appends a finalized assistant message', () => {
    const before: FinalItem[] = [{ kind: 'user-message', id: 'u1', content: 'hi' }];
    const after = pushFinalizedAssistant(before, {
      id: 'a1',
      segments: [
        { kind: 'text', content: 'done.' },
        { kind: 'tool_call', id: 't1', name: 'read', input: {}, result: { kind: 'ok', content: 'file contents' } },
      ],
    });
    expect(after).toHaveLength(2);
    expect(after[1]!.kind).toBe('assistant-message');
    const am = after[1] as Extract<FinalItem, { kind: 'assistant-message' }>;
    expect(am.segments).toHaveLength(2);
  });

  test('items are immutable (new array on push)', () => {
    const before: FinalItem[] = [];
    const after1 = finalizedReducer(before, { type: 'USER_SUBMIT', id: 'u1', content: 'a' });
    const after2 = finalizedReducer(after1, { type: 'USER_SUBMIT', id: 'u2', content: 'b' });
    expect(after1).toHaveLength(1);
    expect(after2).toHaveLength(2);
    expect(after1).not.toBe(after2);
  });
});

describe('activeReducer', () => {
  const startState: ActiveState = { streamingAssistant: { id: 'a1', segments: [], thinking: null } };

  test('ASSISTANT_START creates streaming assistant', () => {
    const initial: ActiveState = { streamingAssistant: null };
    const next = activeReducer(initial, { type: 'ASSISTANT_START', id: 'a1' });
    expect(next.streamingAssistant).not.toBeNull();
    expect(next.streamingAssistant!.id).toBe('a1');
    expect(next.streamingAssistant!.segments).toEqual([]);
  });

  test('STREAM_TEXT_DELTA appends text segment', () => {
    const next = activeReducer(startState, { type: 'STREAM_TEXT_DELTA', delta: 'Hello' });
    expect(next.streamingAssistant!.segments).toEqual([{ kind: 'text', content: 'Hello', flushedLength: 0 }]);
  });

  test('STREAM_TEXT_DELTA merges consecutive text segments', () => {
    let state = activeReducer(startState, { type: 'STREAM_TEXT_DELTA', delta: 'Hello' });
    state = activeReducer(state, { type: 'STREAM_TEXT_DELTA', delta: ' world' });
    expect(state.streamingAssistant!.segments).toHaveLength(1);
    expect(state.streamingAssistant!.segments[0]).toEqual({ kind: 'text', content: 'Hello world', flushedLength: 0 });
  });

  test('TOOL_START and TOOL_DONE preserve text/tool interleaving', () => {
    let state = activeReducer(startState, { type: 'STREAM_TEXT_DELTA', delta: 'Let me ' });
    expect(state.streamingAssistant!.segments).toHaveLength(1);

    state = activeReducer(state, { type: 'TOOL_START', id: 't1', name: 'read', input: { path: 'f.ts' } });
    expect(state.streamingAssistant!.segments).toHaveLength(2);
    const tool = state.streamingAssistant!.segments[1]!;
    expect(tool.kind).toBe('tool_call');

    state = activeReducer(state, { type: 'TOOL_DONE', id: 't1', result: { kind: 'ok', content: '...' } });
    const done = state.streamingAssistant!.segments[1]!;
    expect(done.kind).toBe('tool_call');
    if (done.kind === 'tool_call') {
      expect(done.status).toBe('done');
      expect(done.result).toEqual({ kind: 'ok', content: '...' });
    }

    state = activeReducer(state, { type: 'STREAM_TEXT_DELTA', delta: 'done.' });
    expect(state.streamingAssistant!.segments).toHaveLength(3);
    expect(state.streamingAssistant!.segments[0]).toEqual({ kind: 'text', content: 'Let me ', flushedLength: 0 });
    expect(state.streamingAssistant!.segments[1]!.kind).toBe('tool_call');
    expect(state.streamingAssistant!.segments[2]).toEqual({ kind: 'text', content: 'done.', flushedLength: 0 });
  });

  test('CLEAR_ACTIVE sets streamingAssistant to null', () => {
    const next = activeReducer(startState, { type: 'CLEAR_ACTIVE' });
    expect(next.streamingAssistant).toBeNull();
  });
});

describe('interactionReducer', () => {
  const initial: InteractionState = { focusedToolId: null, expandedTools: new Set(), ignoredErrors: new Set(), pendingInputs: [] };

  test('ENQUEUE_PENDING_INPUT adds to queue', () => {
    const next = interactionReducer(initial, { type: 'ENQUEUE_PENDING_INPUT', text: 'hello' });
    expect(next.pendingInputs).toEqual(['hello']);
  });

  test('DEQUEUE_PENDING_INPUT removes first item', () => {
    const withItems = interactionReducer(initial, { type: 'ENQUEUE_PENDING_INPUT', text: 'a' });
    const withMore = interactionReducer(withItems, { type: 'ENQUEUE_PENDING_INPUT', text: 'b' });
    const dequeued = interactionReducer(withMore, { type: 'DEQUEUE_PENDING_INPUT' });
    expect(dequeued.pendingInputs).toEqual(['b']);
  });

  test('MOVE_FOCUS cycles through tool ids', () => {
    let state = interactionReducer(initial, { type: 'MOVE_FOCUS', direction: 1, collapsibleToolIds: ['t1', 't2'] });
    expect(state.focusedToolId).toBe('t1');
    state = interactionReducer(state, { type: 'MOVE_FOCUS', direction: 1, collapsibleToolIds: ['t1', 't2'] });
    expect(state.focusedToolId).toBe('t2');
    state = interactionReducer(state, { type: 'MOVE_FOCUS', direction: 1, collapsibleToolIds: ['t1', 't2'] });
    expect(state.focusedToolId).toBe('t1');
  });

  test('MOVE_FOCUS with empty list clears focus', () => {
    const withFocus: InteractionState = { ...initial, focusedToolId: 't1' };
    const next = interactionReducer(withFocus, { type: 'MOVE_FOCUS', direction: 1, collapsibleToolIds: [] });
    expect(next.focusedToolId).toBeNull();
  });
});

describe('statsReducer', () => {
  const initial: StatsState = { promptTokens: 0, completionTokens: 0, totalTokens: 0, contextTokens: 0, streaming: false, streamingStartTime: null, interrupted: false };

  test('STREAMING_START sets streaming and startTime', () => {
    const next = statsReducer(initial, { type: 'STREAMING_START' });
    expect(next.streaming).toBe(true);
    expect(next.streamingStartTime).toBeGreaterThan(0);
    expect(next.interrupted).toBe(false);
  });

  test('ACCUMULATE_USAGE snapshots prompt and accumulates completion', () => {
    let state = statsReducer(initial, { type: 'ACCUMULATE_USAGE', usage: { prompt_tokens: 100, completion_tokens: 50 } });
    expect(state.promptTokens).toBe(100);
    expect(state.completionTokens).toBe(50);
    state = statsReducer(state, { type: 'ACCUMULATE_USAGE', usage: { prompt_tokens: 80, completion_tokens: 40 } });
    expect(state.promptTokens).toBe(80);   // latest snapshot, not accumulated
    expect(state.completionTokens).toBe(90);  // accumulated
  });
});

describe('uiReducer (combined)', () => {
  test('USER_SUBMIT adds to finalized and starts active', () => {
    const next = uiReducer(initialUIState, { type: 'USER_SUBMIT', id: 'u1', content: 'hi' });
    expect(next.finalizedItems).toEqual([{ kind: 'user-message', id: 'u1', content: 'hi' }]);
    expect(next.active.streamingAssistant).toBeNull(); // ASSISTANT_START not called yet
  });

  test('STREAM_TEXT_DELTA does NOT mutate finalized items', () => {
    const withUser = uiReducer(initialUIState, { type: 'USER_SUBMIT', id: 'u1', content: 'hi' });
    const withActive = uiReducer(withUser, { type: 'ASSISTANT_START', id: 'a1' });
    const before = withActive.finalizedItems;
    const after = uiReducer(withActive, { type: 'STREAM_TEXT_DELTA', delta: 'hello' });
    expect(after.finalizedItems).toBe(before); // Same reference
  });

  test('FLUSH_TO_FINALIZED moves active to finalized and clears active', () => {
    let state = uiReducer(initialUIState, { type: 'USER_SUBMIT', id: 'u1', content: 'hi' });
    state = uiReducer(state, { type: 'ASSISTANT_START', id: 'a1' });
    state = uiReducer(state, { type: 'STREAM_TEXT_DELTA', delta: 'response' });
    state = uiReducer(state, { type: 'FLUSH_TO_FINALIZED' });

    expect(state.finalizedItems).toHaveLength(2); // user + assistant
    const assistant = state.finalizedItems[1]!;
    expect(assistant.kind).toBe('assistant-message');
    if (assistant.kind === 'assistant-message') {
      expect(assistant.segments).toEqual([{ kind: 'text', content: 'response' }]);
    }
    // Active must be cleared after flush — no double-render
    expect(state.active.streamingAssistant).toBeNull();
    expect(state.stats.streaming).toBe(false);
  });

  test('APPEND_DIVIDER + CLEAR_ACTIVE for /clear', () => {
    let state = uiReducer(initialUIState, { type: 'USER_SUBMIT', id: 'u1', content: 'hi' });
    state = uiReducer(state, { type: 'APPEND_DIVIDER', reason: 'clear' });
    state = uiReducer(state, { type: 'CLEAR_ACTIVE' });
    expect(state.finalizedItems).toHaveLength(2); // user + divider
    expect(state.finalizedItems[1]!.kind).toBe('divider');
    expect(state.active.streamingAssistant).toBeNull();
    expect(state.stats.streaming).toBe(false);
  });

  test('APPEND_SYSTEM_NOTICE adds a dimmed system notice', () => {
    let state = uiReducer(initialUIState, { type: 'APPEND_SYSTEM_NOTICE', id: 'n1', content: 'Saved session abc (5 messages)' });
    expect(state.finalizedItems).toEqual([{ kind: 'system-notice', id: 'n1', content: 'Saved session abc (5 messages)' }]);
  });

  test('RESET_FINALIZED_FROM_MESSAGES replaces finalizedItems from messages', () => {
    const state = uiReducer(initialUIState, {
      type: 'RESET_FINALIZED_FROM_MESSAGES',
      messages: [
        { role: 'user', id: 'u1', content: 'hello' },
        { role: 'assistant', id: 'a1', content: '', blocks: [
          { type: 'text', text: 'hi there' },
          { type: 'tool_use', id: 't1', name: 'read', input: {} },
        ] },
        { role: 'tool', content: 'file ok', tool_call_id: 't1' },
      ],
    });
    expect(state.finalizedItems).toHaveLength(2);
    expect(state.finalizedItems[0]).toEqual({ kind: 'user-message', id: 'u1', content: 'hello' });
    const am = state.finalizedItems[1]!;
    expect(am.kind).toBe('assistant-message');
    if (am.kind === 'assistant-message') {
      expect(am.segments).toHaveLength(2);
      expect(am.segments[0]).toEqual({ kind: 'text', content: 'hi there', flushedLength: 0 });
      const tc = am.segments[1]!;
      expect(tc.kind).toBe('tool_call');
      if (tc.kind === 'tool_call') {
        expect(tc.result).toEqual({ kind: 'ok', content: 'file ok', durationMs: 0 });
      }
    }
    expect(state.active.streamingAssistant).toBeNull();
  });

  test('RESET_FINALIZED_FROM_MESSAGES skips system and tool messages', () => {
    const state = uiReducer(initialUIState, {
      type: 'RESET_FINALIZED_FROM_MESSAGES',
      messages: [
        { role: 'system', content: 'instructions' },
        { role: 'user', id: 'u1', content: 'hi' },
        { role: 'tool', content: 'result', tool_call_id: 'orphan' },
      ],
    });
    expect(state.finalizedItems).toHaveLength(1);
    expect(state.finalizedItems[0]!.kind).toBe('user-message');
  });

  test('RESET_FINALIZED_FROM_MESSAGES handles tool error results', () => {
    const state = uiReducer(initialUIState, {
      type: 'RESET_FINALIZED_FROM_MESSAGES',
      messages: [
        { role: 'assistant', id: 'a1', content: '', blocks: [
          { type: 'tool_use', id: 't1', name: 'bash', input: {} },
        ] },
        { role: 'tool', content: 'permission denied', tool_call_id: 't1', name: 'error' },
      ],
    });
    const am = state.finalizedItems[0]!;
    if (am.kind === 'assistant-message') {
      const tc = am.segments[0]!;
      if (tc.kind === 'tool_call') {
        expect(tc.result).toEqual({ kind: 'error', message: 'permission denied', durationMs: 0 });
      }
    }
  });
});
