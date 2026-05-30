import { describe, test, expect } from 'bun:test';
import { normalizeKey } from '../../src/extensions/frontend.tui/keys/normalize';
import type { InkKey } from '../../src/extensions/frontend.tui/input/key-dispatcher';

function k(overrides: Partial<InkKey> = {}): InkKey {
  return {
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
    escape: false, return: false, tab: false, backspace: false,
    delete: false, ctrl: false, meta: false, shift: false, shiftTab: false,
    ...overrides,
  };
}

describe('normalizeKey', () => {
  // Named keys
  test('return → enter', () => expect(normalizeKey('', k({ return: true })).key).toBe('enter'));
  test('escape → escape', () => expect(normalizeKey('', k({ escape: true })).key).toBe('escape'));
  test('tab → tab', () => expect(normalizeKey('', k({ tab: true })).key).toBe('tab'));
  test('backspace → backspace', () => expect(normalizeKey('', k({ backspace: true })).key).toBe('backspace'));
  test('delete → delete', () => expect(normalizeKey('', k({ delete: true })).key).toBe('delete'));
  test('upArrow → up', () => expect(normalizeKey('', k({ upArrow: true })).key).toBe('up'));
  test('downArrow → down', () => expect(normalizeKey('', k({ downArrow: true })).key).toBe('down'));
  test('leftArrow → left', () => expect(normalizeKey('', k({ leftArrow: true })).key).toBe('left'));
  test('rightArrow → right', () => expect(normalizeKey('', k({ rightArrow: true })).key).toBe('right'));

  // Ctrl propagation
  test('ctrl+t → key=t, ctrl=true', () => {
    const ev = normalizeKey('t', k({ ctrl: true }));
    expect(ev.key).toBe('t');
    expect(ev.ctrl).toBe(true);
  });

  // Modifier flags
  test('meta flag propagated', () => {
    expect(normalizeKey('a', k({ meta: true })).meta).toBe(true);
  });
  test('shift flag propagated', () => {
    expect(normalizeKey('a', k({ shift: true })).shift).toBe(true);
  });

  // macOS option+arrow dual-fallback
  test('\\x1bb maps to left with meta=true', () => {
    const ev = normalizeKey('\x1bb', k());
    expect(ev.key).toBe('left');
    expect(ev.meta).toBe(true);
  });
  test('\\x1bf maps to right with meta=true', () => {
    const ev = normalizeKey('\x1bf', k());
    expect(ev.key).toBe('right');
    expect(ev.meta).toBe(true);
  });
  test('\\x1b[1;3D maps to left with meta=true', () => {
    const ev = normalizeKey('\x1b[1;3D', k());
    expect(ev.key).toBe('left');
    expect(ev.meta).toBe(true);
  });
  test('\\x1b[1;3C maps to right with meta=true', () => {
    const ev = normalizeKey('\x1b[1;3C', k());
    expect(ev.key).toBe('right');
    expect(ev.meta).toBe(true);
  });

  // Plain character pass-through
  test('plain character a passes through', () => {
    const ev = normalizeKey('a', k());
    expect(ev.key).toBe('a');
    expect(ev.ctrl).toBe(false);
    expect(ev.meta).toBe(false);
  });

  // Bracketed paste pass-through
  test('[I bracketed paste focus passes through raw', () => {
    const ev = normalizeKey('[I', k());
    expect(ev.raw).toBe('[I');
    expect(ev.key).toBe('[I');
  });
  test('[O bracketed paste end passes through', () => {
    const ev = normalizeKey('[O', k());
    expect(ev.raw).toBe('[O');
  });

  // Ctrl+letter retains key as lowercase letter
  test('ctrl+shift+A → key=a', () => {
    const ev = normalizeKey('a', k({ ctrl: true, shift: true }));
    expect(ev.key).toBe('a');
    expect(ev.ctrl).toBe(true);
    expect(ev.shift).toBe(true);
  });
});
