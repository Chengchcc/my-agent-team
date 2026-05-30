import { describe, test, expect } from 'bun:test';
import { KeyDispatcher, keyDispatcher } from '../../src/extensions/frontend.tui/input/key-dispatcher';
import type { KeyEvent } from '../../src/extensions/frontend.tui/input/key-dispatcher';

function makeEvent(overrides: Partial<KeyEvent> = {}): KeyEvent {
  return {
    key: 'x',
    ctrl: false,
    meta: false,
    shift: false,
    raw: 'x',
    ...overrides,
  };
}

describe('KeyDispatcher', () => {
  test('dispatch returns false when stack is empty', () => {
    const kd = new KeyDispatcher();
    expect(kd.dispatch(makeEvent({ key: 'x' }))).toBe(false);
  });

  test('dispatch stops at first handler returning true (LIFO)', () => {
    const kd = new KeyDispatcher();
    const calls: string[] = [];
    kd.push({ id: 'a', handler: () => { calls.push('a'); return false; } });
    kd.push({ id: 'b', handler: () => { calls.push('b'); return true; } });
    kd.push({ id: 'c', handler: () => { calls.push('c'); return false; } });
    kd.dispatch(makeEvent());
    expect(calls).toEqual(['c', 'b']);
  });

  test('dispatch respects when() gate', () => {
    const kd = new KeyDispatcher();
    let gate = false;
    const calls: string[] = [];
    kd.push({ id: 'gated', priority: 100, when: () => gate, handler: () => { calls.push('gated'); return true; } });
    kd.push({ id: 'fallback', priority: 50, handler: () => { calls.push('fallback'); return true; } });
    kd.dispatch(makeEvent());
    expect(calls).toEqual(['fallback']);

    gate = true;
    kd.dispatch(makeEvent());
    expect(calls).toEqual(['fallback', 'gated']);
  });

  test('push sorts by priority descending, LIFO within same priority', () => {
    const kd = new KeyDispatcher();
    kd.push({ id: 'low', priority: 10, handler: () => false });
    kd.push({ id: 'high', priority: 100, handler: () => false });
    kd.push({ id: 'mid-b', priority: 50, handler: () => false });
    kd.push({ id: 'mid-a', priority: 50, handler: () => false });
    const ids = (kd as unknown as { stack: Array<{ id: string }> }).stack.map(l => l.id);
    expect(ids).toEqual(['high', 'mid-a', 'mid-b', 'low']);
  });

  test('pop removes layer by id', () => {
    const kd = new KeyDispatcher();
    kd.push({ id: 'a', handler: () => false });
    kd.push({ id: 'b', handler: () => false });
    kd.pop('a');
    const ids = (kd as unknown as { stack: Array<{ id: string }> }).stack.map(l => l.id);
    expect(ids).toEqual(['b']);
  });

  test('push with same id replaces existing layer (idempotent)', () => {
    const kd = new KeyDispatcher();
    const calls: string[] = [];
    kd.push({ id: 'x', priority: 10, handler: () => { calls.push('old'); return true; } });
    kd.push({ id: 'x', priority: 50, handler: () => { calls.push('new'); return true; } });
    kd.dispatch(makeEvent());
    expect(calls).toEqual(['new']);
    const ids = (kd as unknown as { stack: Array<{ id: string }> }).stack.map(l => l.id);
    expect(ids).toEqual(['x']);
  });

  test('clear removes all layers', () => {
    const kd = new KeyDispatcher();
    kd.push({ id: 'a', handler: () => false });
    kd.push({ id: 'b', handler: () => false });
    kd.clear();
    expect(kd.depth).toBe(0);
  });

  test('keyDispatcher is a singleton instance', () => {
    expect(keyDispatcher).toBeInstanceOf(KeyDispatcher);
  });
});
