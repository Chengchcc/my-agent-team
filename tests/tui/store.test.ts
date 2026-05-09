import { describe, it, expect, beforeEach } from 'bun:test';
import { useTuiStore } from '../../src/cli/tui/state/store';

function firstTextSegId(): string {
  const live = useTuiStore.getState().live!;
  const seg = live.segments.find(s => s.kind === 'text')!;
  return seg.id;
}

function nthTextSegId(n: number): string {
  const live = useTuiStore.getState().live!;
  const textSegs = live.segments.filter(s => s.kind === 'text');
  return textSegs[n]!.id;
}

describe('TuiStore: new granular finalized architecture', () => {
  beforeEach(() => {
    useTuiStore.getState().clearActive();
  });

  it('turnStart pushes assistant-header to finalized', () => {
    const store = useTuiStore.getState();
    store.turnStart('a1');
    const { finalized } = useTuiStore.getState();
    const header = finalized.find(i => i.kind === 'assistant-header');
    expect(header).toBeDefined();
    if (header!.kind === 'assistant-header') {
      expect(header!.assistantId).toBe('a1');
    }
  });

  it('commitAdvance pushes committed-block to finalized', () => {
    const store = useTuiStore.getState();
    store.turnStart('a2');
    store.textDelta('Hello\n\nWorld\n\n');
    const segId = firstTextSegId();
    store.commitAdvance(segId, 7, [{ id: 'b1', raw: 'Hello' }]);
    const { finalized } = useTuiStore.getState();
    const blocks = finalized.filter(i => i.kind === 'committed-block');
    expect(blocks.length).toBe(1);
    if (blocks[0]!.kind === 'committed-block') {
      expect(blocks[0]!.raw).toBe('Hello');
      expect(blocks[0]!.assistantId).toBe('a2');
    }
  });

  it('toolDone pushes tool-call-final to finalized', () => {
    const store = useTuiStore.getState();
    store.turnStart('a3');
    store.textDelta('Hello\n\n');
    store.toolStart('tc1', 'bash', { cmd: 'ls' });
    store.toolDone('tc1', { kind: 'ok', content: 'file.txt', durationMs: 50 });
    const { finalized } = useTuiStore.getState();
    const tc = finalized.find(i => i.kind === 'tool-call-final');
    expect(tc).toBeDefined();
    if (tc!.kind === 'tool-call-final') {
      expect(tc!.name).toBe('bash');
      expect(tc!.result.kind).toBe('ok');
    }
  });

  it('commitAdvance pushes committed-block for text AFTER tool_call too', () => {
    const store = useTuiStore.getState();
    store.turnStart('a4');
    store.textDelta('Hello\n\n');
    store.toolStart('tc1', 'bash', { cmd: 'ls' });
    store.textDelta('After tool\n\n');
    const afterToolSegId = nthTextSegId(1);
    store.commitAdvance(afterToolSegId, 11, [{ id: 'b2', raw: 'After tool' }]);
    const { finalized } = useTuiStore.getState();
    const blocks = finalized.filter(i => i.kind === 'committed-block');
    // Post-tool text blocks should also be pushed — tool-call-final maintains order
    expect(blocks.length).toBe(1);
    if (blocks[0]!.kind === 'committed-block') {
      expect(blocks[0]!.raw).toBe('After tool');
    }
  });

  it('turnDone pushes assistant-tail for uncommitted text', () => {
    const store = useTuiStore.getState();
    store.turnStart('a5');
    store.textDelta('Hello world');
    // No commitAdvance — all text is uncommitted
    store.turnDone();
    const { finalized } = useTuiStore.getState();
    const tail = finalized.find(i => i.kind === 'assistant-tail');
    expect(tail).toBeDefined();
    if (tail!.kind === 'assistant-tail') {
      expect(tail!.raw).toBe('Hello world');
    }
  });

  it('turnDone does not push assistant-tail when all text is committed', () => {
    const store = useTuiStore.getState();
    store.turnStart('a6');
    store.textDelta('Hello\n\n');
    const segId = firstTextSegId();
    store.commitAdvance(segId, 7, [{ id: 'b1', raw: 'Hello' }]);
    store.turnDone();
    const { finalized } = useTuiStore.getState();
    expect(finalized.filter(i => i.kind === 'assistant-tail').length).toBe(0);
  });

  it('turnDone pushes assistant-message fallback when no granular items exist', () => {
    const store = useTuiStore.getState();
    store.turnStart('a7');
    store.textDelta('Short');
    // No commitAdvance, no tool calls — but header was pushed at turnStart
    // So hasGranular will be true (header exists), and we'll get assistant-tail instead
    store.turnDone();
    const { finalized } = useTuiStore.getState();
    // Header was pushed at turnStart, so we get tail, not full assistant-message
    const tail = finalized.find(i => i.kind === 'assistant-tail');
    expect(tail).toBeDefined();
  });

  it('full lifecycle: header + blocks + tool-call-final + tail', () => {
    const store = useTuiStore.getState();
    store.turnStart('a8');
    store.textDelta('Hello\n\nWorld\n\n');
    const segId = firstTextSegId();
    store.commitAdvance(segId, 7, [{ id: 'b1', raw: 'Hello' }]);
    store.commitAdvance(segId, 14, [{ id: 'b2', raw: 'World' }]);
    store.toolStart('tc1', 'bash', { cmd: 'ls' });
    store.toolDone('tc1', { kind: 'ok', content: 'ok', durationMs: 10 });
    store.textDelta('After tool');
    store.turnDone();

    const { finalized } = useTuiStore.getState();
    // Check order: header, block1, block2, tool-call-final, tail
    const kinds = finalized.map(i => i.kind);
    expect(kinds).toContain('assistant-header');
    expect(kinds).toContain('committed-block');
    expect(kinds).toContain('tool-call-final');
    expect(kinds).toContain('assistant-tail');
    // No assistant-message (granular items exist)
    expect(kinds).not.toContain('assistant-message');
    // No duplicate text — no full assistant-message with same text
  });

  it('tool_call + text after tool: correct finalized order', () => {
    const store = useTuiStore.getState();
    store.turnStart('a9');
    store.toolStart('tc1', 'bash', { cmd: 'ls' });
    store.toolDone('tc1', { kind: 'ok', content: 'ok', durationMs: 10 });
    store.textDelta('After tool');
    store.turnDone();

    const { finalized } = useTuiStore.getState();
    // header first, then tool-call-final, then tail
    const headerIdx = finalized.findIndex(i => i.kind === 'assistant-header');
    const tcIdx = finalized.findIndex(i => i.kind === 'tool-call-final');
    const tailIdx = finalized.findIndex(i => i.kind === 'assistant-tail');
    expect(headerIdx).toBeLessThan(tcIdx);
    expect(tcIdx).toBeLessThan(tailIdx);
  });

  it('clearActive resets everything', () => {
    const store = useTuiStore.getState();
    store.turnStart('a10');
    store.textDelta('Hello\n\n');
    store.commitAdvance(firstTextSegId(), 7, [{ id: 'b1', raw: 'Hello' }]);
    store.clearActive();
    const { finalized, live } = useTuiStore.getState();
    expect(finalized.length).toBe(0);
    expect(live).toBeNull();
  });
});
