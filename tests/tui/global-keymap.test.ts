import { describe, test, expect } from 'bun:test';
import { GLOBAL_BINDINGS } from '../../src/extensions/frontend.tui/keys/global-keymap';
import type { GlobalBinding } from '../../src/extensions/frontend.tui/keys/global-keymap';

describe('GLOBAL_BINDINGS', () => {
  test('no duplicate global binding chord', () => {
    const seen = new Map<string, GlobalBinding>();
    for (const b of GLOBAL_BINDINGS) {
      const chord = `${b.ctrl ? 'C-' : ''}${b.meta ? 'M-' : ''}${b.shift ? 'S-' : ''}${b.key}`;
      const existing = seen.get(chord);
      if (existing && existing !== b) {
        // Same chord without guards = conflict
        if (!existing.guard && !b.guard) {
          throw new Error(`Duplicate chord "${chord}" for bindings: ${b.id}, ${existing.id}`);
        }
      }
      seen.set(chord, b);
    }
  });

  test('all bindings have unique ids', () => {
    const ids = GLOBAL_BINDINGS.map(b => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('footer hints have hintPriority set', () => {
    const footerBindings = GLOBAL_BINDINGS.filter(b => b.showInFooter);
    for (const b of footerBindings) {
      expect(b.hintPriority).toBeDefined();
    }
  });
});
