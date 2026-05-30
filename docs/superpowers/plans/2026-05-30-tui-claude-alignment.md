# TUI Claude-Code 对齐与视觉提级 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align TUI with Claude Code interaction patterns via unified key routing, tool split (text_editor→edit/write), permission overlay diff preview, slash/bash shortcuts, and visual polish.

**Architecture:** PR-1 upgrades KeyDispatcher with priority+when() gating and creates the single useInput entry point. All downstream PRs build on this base. PR-4 splits text_editor into edit+write tools with structured diff output. PR-5 consumes diff for permission overlay previews. PR-7a adds ext-source slash `!` bash shortcut. Visual PRs (8-9) are leaf-level refactors.

**Tech Stack:** TypeScript + Bun + Ink 5 + Zustand + Zod + nanoid + diff (new dep for PR-4)

**Spec:** `docs/superpowers/specs/2026-05-30-tui-claude-alignment.md`

---

## File Map

### New files (28)

| File | Responsibility | PR |
|---|---|---|
| `src/extensions/frontend.tui/keys/priority.ts` | PRIORITY constants | 1 |
| `src/extensions/frontend.tui/keys/use-key-layer.ts` | React hook wrapping KeyDispatcher push/pop | 1 |
| `src/extensions/frontend.tui/keys/normalize.ts` | Ink key → canonical KeyEvent | 1 |
| `src/extensions/frontend.tui/keys/global-keymap.ts` | GLOBAL_BINDINGS table + GlobalKeyCtx type | 1 |
| `src/extensions/frontend.tui/keys/input-keymap.ts` | INPUT_BINDINGS table (editor keys) | 1 |
| `src/extensions/frontend.tui/keys/picker-keymap.ts` | PICKER_BINDINGS table | 1 |
| `src/extensions/frontend.tui/input/input-prefixes.ts` | INPUT_PREFIXES constants | 7a |
| `src/extensions/frontend.tui/components/use-spinner.ts` | useSpinner hook (extracted from StreamingIndicator) | 9 |
| `src/application/contracts/tool-schemas/edit.ts` | EditArgs zod schema | 4 |
| `src/application/contracts/tool-schemas/write.ts` | WriteArgs zod schema | 4 |
| `src/extensions/tools/edit.ts` | Edit tool execute | 4 |
| `src/extensions/tools/write.ts` | Write tool execute | 4 |
| `src/extensions/tools/_diff.ts` | buildDiffHunks using `diff` lib | 4 |
| `src/extensions/tools/slash-bash.ts` | `/!` ext-source slash command | 7a |
| `src/extensions/frontend-capability-hints/index.ts` | transformPrompt hook injecting `<!-- user-shortcuts -->` | 7a |
| `src/extensions/permission/store.ts` | PermissionStore (persist always-allow to disk) | 6 |
| `src/application/slash/builtin/permissions.ts` | `/permissions` slash command | 6 |
| `src/extensions/frontend.tui/overlays/impls/overlay-permission/preview.tsx` | DiffPreview/WritePreview/CommandPreview/JsonPreview | 5 |
| `src/extensions/frontend.tui/overlays/impls/overlay-cheatsheet.tsx` | Cheatsheet overlay (consume 三表 union) | 7b |
| `tests/extensions/frontend.tui/keys/dispatcher.test.ts` | KeyDispatcher priority/when tests | 1 |
| `tests/extensions/frontend.tui/keys/normalize.test.ts` | normalizeKey test matrix | 1 |
| `tests/extensions/frontend.tui/keys/global-keymap.test.ts` | GLOBAL_BINDINGS no-duplicate-chord test | 1 |
| `tests/extensions/tools/edit.test.ts` | Edit tool unit tests | 4 |
| `tests/extensions/tools/write.test.ts` | Write tool unit tests | 4 |
| `tests/extensions/tools/_diff.test.ts` | buildDiffHunks unit tests | 4 |
| `tests/extensions/permission/store.test.ts` | PermissionStore tests | 6 |
| `tests/extensions/frontend.tui/keys/use-spinner.test.tsx` | useSpinner tick test | 9 |
| `tests/extensions/frontend.tui/keys/format-hints.test.ts` | Footer hint format test | 8 |

### Modified files (25)

| File | Changes | PR |
|---|---|---|
| `src/extensions/frontend.tui/input/key-dispatcher.ts` | Add priority sort + `when()` gating | 1 |
| `src/extensions/frontend.tui/App.tsx` | Single useInput + GLOBAL_CHROME layer + GLOBAL_BINDINGS action dispatch + inkInstance ref + transient hint | 1,3,7b |
| `src/extensions/frontend.tui/run-tui.tsx` | Expose inkInstance via ref | 3 |
| `src/extensions/frontend.tui/views/chrome/Footer.tsx` | 3-section layout + dynamic hints from GLOBAL_BINDINGS | 8 |
| `src/extensions/frontend.tui/views/chrome/Header.tsx` | Mode badge inverse | 8 |
| `src/extensions/frontend.tui/views/chrome/InputBox.tsx` | Remove useInput + borderColor 3-state + pending compact + paste slim | 2,8,9 |
| `src/extensions/frontend.tui/views/chrome/StreamingIndicator.tsx` | Use extracted useSpinner hook | 9 |
| `src/extensions/frontend.tui/views/chrome/keymap.ts` | DELETE (replaced by keys/*) | 1 |
| `src/extensions/frontend.tui/slash/input-key-handler.ts` | Remove ctrl+c branch + add `!`→`/!` rewrite + remove useInput routing | 2,3,7a |
| `src/extensions/frontend.tui/slash/use-slash-input.ts` | Remove useInput, replace with useKeyLayer(PICKER) | 2 |
| `src/extensions/frontend.tui/hooks/use-input-editor.ts` | Add word/line cursor functions | 3 |
| `src/extensions/frontend.tui/hooks/use-input-history.ts` | Skip pattern add `!` prefix | 7a |
| `src/extensions/frontend.tui/state/types.ts` | Divider add id + InteractionState add thinkingVisible/debugVisible/transientHints + pendingInputs→{id,text}[] | 1,3,8 |
| `src/extensions/frontend.tui/state/store.ts` | appendDivider nanoid + toggleThinking/toggleDebug + pendingInputs typed + transient hints | 1,3,8 |
| `src/extensions/frontend.tui/overlays/impls/overlay-permission/overlay-permission.tsx` | Insert ToolInputPreview | 5 |
| `src/extensions/frontend.tui/overlays/impls/overlay-permission/use-permission-manager.ts` | PermissionRequest add input/cwd | 5 |
| `src/extensions/frontend.tui/components/file-picker-popover.tsx` | `>`→`❯` + borderStyle round | 7b,9 |
| `src/extensions/frontend.tui/slash/components/slash-command-list.tsx` | borderStyle single→round + borderColor gray | 9 |
| `src/extensions/frontend.tui/views/final/UserMessageView.tsx` | `│ ` prefix, 200-line threshold | 9 |
| `src/extensions/frontend.tui/widgets/impls/widget-subagent-task.tsx` | Remove useInput + collapse to single-line summary | 2 |
| `src/application/contracts/permission-events.ts` | PermissionRequiredV1 add input/cwd/inputTruncated/description | 5 |
| `src/application/slash/builtin/slash-help.ts` | Append keyboard shortcuts from ctx.ui.getCheatsheet | 7b |
| `src/application/slash/slash-types.ts` | SlashContext.ui add getCheatsheet | 7b |
| `src/extensions/tools/index.ts` | Replace text_editor with edit+write + deprecated alias | 4 |
| `src/extensions/permission/index.ts` | dangerousTools sync + input/cwd in emit + PermissionStore integration | 5,6 |
| `src/infrastructure/paths/agent-paths.ts` | AgentPaths add permissions field | 6 |

### Deleted files (3)

| File | PR |
|---|---|
| `src/extensions/frontend.tui/views/chrome/keymap.ts` | 1 |
| `src/application/contracts/tool-schemas/text-editor.ts` | 4 |
| `src/extensions/tools/text-editor.ts` | 4 |

---

## PR-1: Architecture Base (~200 LOC)

### Task 1.1: Add `when()` gating + priority sort to KeyDispatcher

**Files:**
- Modify: `src/extensions/frontend.tui/input/key-dispatcher.ts:1-95`

- [ ] **Step 1: Update KeyLayer and KeyEvent types**

```ts
// key-dispatcher.ts — replace KeyLayer interface (line 20-24)
export interface KeyLayer {
  id: string;
  handler: KeyHandler;
  priority?: number;
  /** Dynamic gate. If present and returns false, this layer is skipped. */
  when?: () => boolean;
}

// Add 'key' field to KeyEvent (line 3-18, replace)
export interface KeyEvent {
  key: string;           // normalized key name: 't', 'enter', 'escape', etc.
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  raw: string;           // original input string
}
```

- [ ] **Step 2: Make `push()` sort by priority descending**

```ts
// key-dispatcher.ts — replace push method (line 67-70)
push(layer: KeyLayer): void {
  this.pop(layer.id);
  const prio = layer.priority ?? 0;
  let i = 0;
  for (; i < this.stack.length; i++) {
    if ((this.stack[i]!.priority ?? 0) < prio) break;
  }
  this.stack.splice(i, 0, layer);
}
```

- [ ] **Step 3: Update `dispatch()` to check `when()`**

```ts
// key-dispatcher.ts — replace dispatch method (line 79-84)
dispatch(key: KeyEvent): boolean {
  for (let i = this.stack.length - 1; i >= 0; i--) {
    const layer = this.stack[i]!;
    if (layer.when && !layer.when()) continue;
    if (layer.handler(key)) return true;
  }
  return false;
}
```

- [ ] **Step 4: Keep `pop`, `clear`, `depth`, and `InkKey` interface unchanged. Remove `inkKeyToKeyEvent` (moved to normalize.ts)**

- [ ] **Step 5: Write tests**

```ts
// tests/extensions/frontend.tui/keys/dispatcher.test.ts
import { describe, test, expect } from 'bun:test'
import { KeyDispatcher } from '@/extensions/frontend.tui/input/key-dispatcher'

describe('KeyDispatcher', () => {
  test('dispatch returns false when stack is empty', () => {
    const kd = new KeyDispatcher()
    expect(kd.dispatch({ key: 'x', ctrl: false, meta: false, shift: false, raw: 'x' })).toBe(false)
  })

  test('dispatch stops at first handler returning true', () => {
    const kd = new KeyDispatcher()
    const calls: string[] = []
    kd.push({ id: 'a', handler: () => { calls.push('a'); return false } })
    kd.push({ id: 'b', handler: () => { calls.push('b'); return true } })
    kd.push({ id: 'c', handler: () => { calls.push('c'); return true } })
    kd.dispatch({ key: 'x', ctrl: false, meta: false, shift: false, raw: 'x' })
    expect(calls).toEqual(['c'])
  })

  test('dispatch respects when() gate', () => {
    const kd = new KeyDispatcher()
    let gate = false
    const calls: string[] = []
    kd.push({ id: 'a', priority: 100, when: () => gate, handler: () => { calls.push('a'); return true } })
    kd.push({ id: 'b', priority: 50, handler: () => { calls.push('b'); return true } })
    kd.dispatch({ key: 'x', ctrl: false, meta: false, shift: false, raw: 'x' })
    expect(calls).toEqual(['b'])
    gate = true
    kd.dispatch({ key: 'x', ctrl: false, meta: false, shift: false, raw: 'x' })
    expect(calls).toEqual(['b', 'a'])
  })

  test('push sorts by priority descending, LIFO within same priority', () => {
    const kd = new KeyDispatcher()
    kd.push({ id: 'low', priority: 10, handler: () => false })
    kd.push({ id: 'high', priority: 100, handler: () => false })
    kd.push({ id: 'mid-b', priority: 50, handler: () => false })
    kd.push({ id: 'mid-a', priority: 50, handler: () => false })
    const ids = (kd as any).stack.map((l: any) => l.id)
    expect(ids).toEqual(['high', 'mid-b', 'mid-a', 'low'])
  })

  test('pop removes layer by id', () => {
    const kd = new KeyDispatcher()
    kd.push({ id: 'a', handler: () => false })
    kd.push({ id: 'b', handler: () => false })
    kd.pop('a')
    expect((kd as any).stack.map((l: any) => l.id)).toEqual(['b'])
  })
})
```

- [ ] **Step 6: Run tests**

```bash
bun test tests/extensions/frontend.tui/keys/dispatcher.test.ts
```

Expected: 5 PASS

- [ ] **Step 7: Commit**

```bash
git add src/extensions/frontend.tui/input/key-dispatcher.ts tests/extensions/frontend.tui/keys/dispatcher.test.ts
git commit -m "feat(tui): add priority sort and when() gating to KeyDispatcher"
```

---

### Task 1.2: Create PRIORITY constants

**Files:**
- Create: `src/extensions/frontend.tui/keys/priority.ts`

- [ ] **Step 1: Write file**

```ts
// src/extensions/frontend.tui/keys/priority.ts
export const PRIORITY = {
  /** Cheatsheet overlay, full-screen modals */
  MODAL: 100,
  /** Slash command picker, file picker, session picker */
  PICKER: 80,
  /** Editor keys: ctrl+a/e/w, tab completion, arrow keys */
  INPUT_EDIT: 40,
  /** Global chrome: ctrl+t/d/o, esc-abort, ctrl+k, ctrl+c, ? */
  GLOBAL_CHROME: 20,
  /** Text insertion fallback — always last */
  FALLTHROUGH: 0,
} as const;
```

- [ ] **Step 2: Commit**

```bash
git add src/extensions/frontend.tui/keys/priority.ts
git commit -m "feat(tui): add KeyDispatcher priority constants"
```

---

### Task 1.3: Create normalizeKey function

**Files:**
- Create: `src/extensions/frontend.tui/keys/normalize.ts`

- [ ] **Step 1: Write normalize.ts**

```ts
// src/extensions/frontend.tui/keys/normalize.ts
import type { InkKey } from '../input/key-dispatcher'
import type { KeyEvent } from '../input/key-dispatcher'

export function normalizeKey(input: string, key: InkKey): KeyEvent {
  const named: string | undefined =
    key.return ? 'enter' :
    key.escape ? 'escape' :
    key.tab ? 'tab' :
    key.backspace ? 'backspace' :
    key.delete ? 'delete' :
    key.upArrow ? 'up' :
    key.downArrow ? 'down' :
    key.leftArrow ? 'left' :
    key.rightArrow ? 'right' :
    key.pageUp ? 'pageup' :
    key.pageDown ? 'pagedown' :
    undefined;

  // macOS option+← dual-fallback: key.meta=true OR escape sequence
  if (input === '\x1bb' || input === '\x1b[1;3D') {
    return { key: 'left', ctrl: !!key.ctrl, meta: true, shift: !!key.shift, raw: input };
  }
  if (input === '\x1bf' || input === '\x1b[1;3C') {
    return { key: 'right', ctrl: !!key.ctrl, meta: true, shift: !!key.shift, raw: input };
  }

  return {
    key: named ?? input,
    ctrl: !!key.ctrl,
    meta: !!key.meta,
    shift: !!key.shift,
    raw: input,
  };
}
```

- [ ] **Step 2: Write tests**

```ts
// tests/extensions/frontend.tui/keys/normalize.test.ts
import { describe, test, expect } from 'bun:test'
import { normalizeKey } from '@/extensions/frontend.tui/keys/normalize'

function inkKey(overrides: Record<string, boolean> = {}) {
  return { upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, escape: false, return: false, tab: false, backspace: false, delete: false, ctrl: false, meta: false, shift: false, shiftTab: false, ...overrides }
}

describe('normalizeKey', () => {
  // Named keys
  test('return → enter', () => expect(normalizeKey('', inkKey({ return: true })).key).toBe('enter'))
  test('escape → escape', () => expect(normalizeKey('', inkKey({ escape: true })).key).toBe('escape'))
  test('tab → tab', () => expect(normalizeKey('', inkKey({ tab: true })).key).toBe('tab'))
  test('backspace → backspace', () => expect(normalizeKey('', inkKey({ backspace: true })).key).toBe('backspace'))
  test('delete → delete', () => expect(normalizeKey('', inkKey({ delete: true })).key).toBe('delete'))
  test('upArrow → up', () => expect(normalizeKey('', inkKey({ upArrow: true })).key).toBe('up'))
  test('downArrow → down', () => expect(normalizeKey('', inkKey({ downArrow: true })).key).toBe('down'))
  test('leftArrow → left', () => expect(normalizeKey('', inkKey({ leftArrow: true })).key).toBe('left'))
  test('rightArrow → right', () => expect(normalizeKey('', inkKey({ rightArrow: true })).key).toBe('right'))

  // Ctrl propagation
  test('ctrl+t → key=t, ctrl=true', () => {
    const ev = normalizeKey('t', inkKey({ ctrl: true }))
    expect(ev.key).toBe('t')
    expect(ev.ctrl).toBe(true)
  })

  // macOS option+arrow dual-fallback
  test('\\x1bb → left with meta=true', () => {
    const ev = normalizeKey('\x1bb', inkKey())
    expect(ev.key).toBe('left')
    expect(ev.meta).toBe(true)
  })
  test('\\x1bf → right with meta=true', () => {
    const ev = normalizeKey('\x1bf', inkKey())
    expect(ev.key).toBe('right')
    expect(ev.meta).toBe(true)
  })
  test('\\x1b[1;3D → left with meta=true', () => {
    const ev = normalizeKey('\x1b[1;3D', inkKey())
    expect(ev.key).toBe('left')
    expect(ev.meta).toBe(true)
  })
  test('\\x1b[1;3C → right with meta=true', () => {
    const ev = normalizeKey('\x1b[1;3C', inkKey())
    expect(ev.key).toBe('right')
    expect(ev.meta).toBe(true)
  })

  // Plain character
  test('plain character passes through', () => {
    const ev = normalizeKey('a', inkKey())
    expect(ev.key).toBe('a')
    expect(ev.ctrl).toBe(false)
    expect(ev.meta).toBe(false)
  })

  // CSS brackets paste pass-through
  test('[I bracketed paste focus passes through raw', () => {
    const ev = normalizeKey('[I', inkKey())
    expect(ev.raw).toBe('[I')
    expect(ev.key).toBe('[I')
  })
})
```

- [ ] **Step 3: Run tests**

```bash
bun test tests/extensions/frontend.tui/keys/normalize.test.ts
```

Expected: 14 PASS

- [ ] **Step 4: Commit**

```bash
git add src/extensions/frontend.tui/keys/normalize.ts tests/extensions/frontend.tui/keys/normalize.test.ts
git commit -m "feat(tui): add normalizeKey for Ink input normalization"
```

---

### Task 1.4: Create useKeyLayer hook

**Files:**
- Create: `src/extensions/frontend.tui/keys/use-key-layer.ts`

- [ ] **Step 1: Write hook**

```ts
// src/extensions/frontend.tui/keys/use-key-layer.ts
import { useEffect, useRef, useMemo } from 'react';
import { keyDispatcher } from '../input/key-dispatcher';
import type { KeyLayer } from '../input/key-dispatcher';

export function useKeyLayer(
  layer: Omit<KeyLayer, 'id'> & { id?: string },
  deps: unknown[] = [],
): void {
  const id = useMemo(() => layer.id ?? `layer-${Math.random().toString(36).slice(2, 8)}`, []);
  const handleRef = useRef(layer.handler);
  handleRef.current = layer.handler;

  useEffect(() => {
    const wrappedHandler = (ev: Parameters<typeof layer.handler>[0]) => handleRef.current(ev);
    keyDispatcher.push({ ...layer, id, handler: wrappedHandler });
    return () => { keyDispatcher.pop(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, layer.priority, ...deps]);
}
```

Note: `keyDispatcher` is imported from `input/key-dispatcher.ts` as a module singleton. The existing file already exports `KeyDispatcher` as a class — we need to also export a singleton instance. Let's add it:

```ts
// At the bottom of key-dispatcher.ts, add:
export const keyDispatcher = new KeyDispatcher();
```

- [ ] **Step 2: Commit**

```bash
git add src/extensions/frontend.tui/input/key-dispatcher.ts src/extensions/frontend.tui/keys/use-key-layer.ts
git commit -m "feat(tui): add useKeyLayer hook and keyDispatcher singleton export"
```

---

### Task 1.5: Create global-keymap.ts (GLOBAL_BINDINGS table)

**Files:**
- Create: `src/extensions/frontend.tui/keys/global-keymap.ts`
- Delete: `src/extensions/frontend.tui/views/chrome/keymap.ts`

- [ ] **Step 1: Define GlobalBinding interface and GLOBAL_BINDINGS**

```ts
// src/extensions/frontend.tui/keys/global-keymap.ts
export interface GlobalKeyCtx {
  streaming: boolean;
  pendingCount: number;
  inputFocused: boolean;
  mode: string;
}

export interface GlobalBinding {
  id: string;
  label: string;
  description: string;
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  scope: 'global' | 'modal-trigger';
  hintPriority?: number;
  showInFooter?: boolean;
  guard?: (ctx: GlobalKeyCtx) => boolean;
  action: string;
}

export const GLOBAL_BINDINGS: ReadonlyArray<GlobalBinding> = [
  {
    id: 'ctrl-c',
    label: 'Ctrl+C×2',
    description: 'Exit (or abort streaming)',
    key: 'c',
    ctrl: true,
    scope: 'global',
    showInFooter: true,
    hintPriority: 100,
    action: 'exit-or-abort',
  },
  {
    id: 'esc-abort',
    label: 'Esc',
    description: 'Interrupt streaming',
    key: 'escape',
    scope: 'global',
    guard: (ctx) => ctx.streaming,
    showInFooter: true,
    hintPriority: 90,
    action: 'abort',
  },
  {
    id: 'ctrl-t',
    label: 'Ctrl+T',
    description: 'Toggle thinking display',
    key: 't',
    ctrl: true,
    scope: 'global',
    action: 'toggle-thinking',
  },
  {
    id: 'ctrl-d',
    label: 'Ctrl+D',
    description: 'Toggle debug display',
    key: 'd',
    ctrl: true,
    scope: 'global',
    action: 'toggle-debug',
  },
  {
    id: 'ctrl-o',
    label: 'Ctrl+O',
    description: 'Toggle tool details',
    key: 'o',
    ctrl: true,
    scope: 'global',
    action: 'toggle-expand',
  },
  {
    id: 'space-expand',
    label: 'Space',
    description: 'Toggle tool details (when not in input)',
    key: ' ',
    scope: 'global',
    guard: (ctx) => !ctx.inputFocused,
    action: 'toggle-expand',
  },
  {
    id: 'ctrl-k',
    label: 'Ctrl+K',
    description: 'Clear pending queue',
    key: 'k',
    ctrl: true,
    scope: 'global',
    guard: (ctx) => ctx.pendingCount > 0,
    showInFooter: true,
    hintPriority: 60,
    action: 'clear-pending',
  },
  {
    id: 'cheatsheet',
    label: '?',
    description: 'Show keyboard shortcuts',
    key: '?',
    scope: 'modal-trigger',
    guard: (ctx) => !ctx.inputFocused,
    showInFooter: true,
    hintPriority: 50,
    action: 'open-cheatsheet',
  },
];
```

- [ ] **Step 2: Create input-keymap.ts (INPUT_BINDINGS — editor keys)**

```ts
// src/extensions/frontend.tui/keys/input-keymap.ts
export interface InputBinding {
  id: string;
  label: string;
  description: string;
  match: (ev: { key: string; ctrl: boolean; meta: boolean; shift: boolean }) => boolean;
  handler: () => void;
}

// Populated by InputBox component (K-1 word/line functions reference these)
export const INPUT_BINDINGS: InputBinding[] = [];
```

- [ ] **Step 3: Create picker-keymap.ts (PICKER_BINDINGS — picker keys)**

```ts
// src/extensions/frontend.tui/keys/picker-keymap.ts
export interface PickerBinding {
  id: string;
  label: string;
  description: string;
  key: string;
  scope: 'slash-picker' | 'file-picker';
}

export const PICKER_BINDINGS: ReadonlyArray<PickerBinding> = [
  { id: 'picker-up', label: '↑↓', description: 'Navigate items', key: 'up/down', scope: 'slash-picker' },
  { id: 'picker-enter', label: 'Enter', description: 'Select item', key: 'enter', scope: 'slash-picker' },
  { id: 'picker-esc', label: 'Esc', description: 'Close picker', key: 'escape', scope: 'slash-picker' },
];
```

- [ ] **Step 4: Write no-duplicate-chord test**

```ts
// tests/extensions/frontend.tui/keys/global-keymap.test.ts
import { describe, test, expect } from 'bun:test'
import { GLOBAL_BINDINGS } from '@/extensions/frontend.tui/keys/global-keymap'

describe('GLOBAL_BINDINGS', () => {
  test('no duplicate global binding chord', () => {
    const seen = new Set<string>()
    for (const b of GLOBAL_BINDINGS) {
      const chord = `${b.ctrl ? 'C-' : ''}${b.meta ? 'M-' : ''}${b.shift ? 'S-' : ''}${b.key}`
      if (seen.has(chord)) {
        // Allow same chord if guarded by different guard conditions
        const existing = GLOBAL_BINDINGS.filter(x => {
          const c = `${x.ctrl ? 'C-' : ''}${x.meta ? 'M-' : ''}${x.shift ? 'S-' : ''}${x.key}`
          return c === chord && x !== b
        })
        const hasGuardConflict = existing.every(e => e.guard && b.guard)
        if (!hasGuardConflict) {
          throw new Error(`Duplicate chord "${chord}" for bindings: ${b.id}, ${existing.map(e => e.id).join(', ')}`)
        }
      }
      seen.add(chord)
    }
  })
})
```

- [ ] **Step 5: Delete old keymap.ts**

```bash
rm src/extensions/frontend.tui/views/chrome/keymap.ts
```

- [ ] **Step 6: Run tests**

```bash
bun test tests/extensions/frontend.tui/keys/global-keymap.test.ts
```

Expected: 1 PASS (no duplicate chords)

- [ ] **Step 7: Commit**

```bash
git add src/extensions/frontend.tui/keys/global-keymap.ts src/extensions/frontend.tui/keys/input-keymap.ts src/extensions/frontend.tui/keys/picker-keymap.ts tests/extensions/frontend.tui/keys/global-keymap.test.ts
git rm src/extensions/frontend.tui/views/chrome/keymap.ts
git commit -m "feat(tui): replace chrome/keymap.ts with layered keymap tables (global/input/picker)"
```

---

### Task 1.6: Wire App.tsx single useInput + GLOBAL_CHROME layer

**Files:**
- Modify: `src/extensions/frontend.tui/App.tsx`
- Modify: `src/extensions/frontend.tui/state/types.ts`
- Modify: `src/extensions/frontend.tui/state/store.ts`

- [ ] **Step 1: Add store state for thinking/debug visibility + transient hints**

```ts
// state/types.ts — replace InteractionState (line 40-43)
export interface InteractionState {
  toolsExpanded: boolean;
  pendingInputs: string[];
  thinkingVisible: boolean;
  debugVisible: boolean;
}

// Add after StatsState (line 54)
export interface TransientState {
  hint: { text: string; expiresAt: number } | null;
}

// initialInteraction — update (line 74-77)
export const initialInteraction: InteractionState = {
  toolsExpanded: false,
  pendingInputs: [],
  thinkingVisible: true,
  debugVisible: false,
};

// initialTransient
export const initialTransient: TransientState = {
  hint: null,
};
```

- [ ] **Step 2: Add store actions**

```ts
// state/store.ts — add to TuiStore interface:
toggleThinking: () => void;
toggleDebug: () => void;
setTransientHint: (text: string, durationMs: number) => void;

// TransientState in TuiStore:
transient: TransientState;

// buildInteractionActions — add:
toggleThinking: () => set((s) => { s.interaction.thinkingVisible = !s.interaction.thinkingVisible; }),
toggleDebug: () => set((s) => { s.interaction.debugVisible = !s.interaction.debugVisible; }),

// New action:
setTransientHint: (text, durationMs) =>
  set((s) => {
    s.transient.hint = { text, expiresAt: Date.now() + durationMs };
  }),

// Also add to initial state in create():
transient: { ...initialTransient },
```

- [ ] **Step 3: Remove old imports and add new ones in App.tsx**

```tsx
// App.tsx — replace imports
import { KeyDispatcher, keyDispatcher } from './input/key-dispatcher';
import { normalizeKey } from './keys/normalize';
import { PRIORITY } from './keys/priority';
import { useKeyLayer } from './keys/use-key-layer';
import { GLOBAL_BINDINGS, type GlobalKeyCtx } from './keys/global-keymap';
// Remove: import { buildHotkeys } from './views/chrome/keymap';
// Remove: import type { InputBoxCallbacks } from './views/chrome/keymap';
```

- [ ] **Step 4: Replace dual useInput with single useInput + GLOBAL_CHROME layer**

```tsx
// App.tsx — in AppV2 component, replace InputBoxCallbacks + buildHotkeys usage:

// Replace callbacks useMemo (lines 186-194) with:
const actions = useMemo<Record<string, () => void>>(() => ({
  'toggle-thinking': () => useTuiStore.getState().toggleThinking(),
  'toggle-debug': () => useTuiStore.getState().toggleDebug(),
  'toggle-expand': () => { if (!streaming) useTuiStore.getState().toggleToolsExpanded(); },
  'clear-pending': () => useTuiStore.getState().clearPendingInputs(),
  'abort': handleAbort,
  'exit-or-abort': () => { /* handled inline below via inline handler */ },
  'open-cheatsheet': () => { /* PR-7b: open cheatsheet overlay */ },
}), [streaming, handleAbort]);

// Add GLOBAL_CHROME layer
const inputFocused = useRef(true); // Updated by InputBox focus state

const globalCtx: GlobalKeyCtx = useMemo(() => ({
  streaming,
  pendingCount: useTuiStore.getState().interaction.pendingInputs.length,
  inputFocused: inputFocused.current,
  mode: useTuiStore.getState().stats.mode,
}), [streaming]);

// Use useKeyLayer for GLOBAL_CHROME (priority 20)
useKeyLayer({
  priority: PRIORITY.GLOBAL_CHROME,
  handle: (ev) => {
    for (const b of GLOBAL_BINDINGS) {
      if (b.key !== ev.key) continue;
      if (!!b.ctrl !== ev.ctrl) continue;
      if (!!b.meta !== ev.meta) continue;
      if (!!b.shift !== ev.shift) continue;
      if (b.guard) {
        // Re-read ctx on each dispatch for freshness
        const ctx: GlobalKeyCtx = {
          streaming,
          pendingCount: useTuiStore.getState().interaction.pendingInputs.length,
          inputFocused: inputFocused.current,
          mode: useTuiStore.getState().stats.mode,
        };
        if (!b.guard(ctx)) continue;
      }
      // Special inline handler for exit-or-abort
      if (b.action === 'exit-or-abort') {
        handleCtrlC();
        return true;
      }
      actions[b.action]?.();
      return true;
    }
    return false;
  },
});

// Single useInput at App level
useInput((rawInput, rawKey) => {
  keyDispatcher.dispatch(normalizeKey(rawInput, rawKey));
});
```

- [ ] **Step 5: Verify typecheck**

```bash
bun run tsc
```

- [ ] **Step 6: Commit**

```bash
git add src/extensions/frontend.tui/App.tsx src/extensions/frontend.tui/state/types.ts src/extensions/frontend.tui/state/store.ts
git commit -m "feat(tui): wire single useInput + GLOBAL_CHROME layer via KeyDispatcher"
```

---

## PR-2: useInput Consolidation (~85 LOC)

### Task 2.1: Remove useInput from InputBox.tsx

**Files:**
- Modify: `src/extensions/frontend.tui/views/chrome/InputBox.tsx`

- [ ] **Step 1: Remove the useInput block (lines 52-72) and its imports**

```tsx
// InputBox.tsx — remove:
// import { buildHotkeys } from './keymap';
// import type { InputBoxCallbacks } from './keymap';
// import { inkKeyToKeyEvent } from '../../input/key-dispatcher';

// Remove the useInput block entirely (lines 52-72).
// The hotkey dispatch is now handled by App.tsx's single useInput via keyDispatcher.
// InputBox only needs to push an INPUT_EDIT layer for editor keys (PR-3)
// and a FALLTHROUGH layer for text insertion (PR-3).

// Also remove 'callbacks' prop (no longer needed), update InputBoxProps:
interface InputBoxProps {
  commands: SlashCommand[];
  onSubmit: (submission: PromptSubmission) => void;
  onAbort?: () => void;
  keyDispatcher: KeyDispatcherType;
  // callbacks: InputBoxCallbacks;  ← REMOVED
}
```

- [ ] **Step 2: Verify no compilation errors**

```bash
bun run tsc
```

- [ ] **Step 3: Commit**

```bash
git add src/extensions/frontend.tui/views/chrome/InputBox.tsx
git commit -m "fix(tui): remove duplicate useInput from InputBox (consolidated to App layer)"
```

---

### Task 2.2: Remove useInput from use-slash-input.ts

**Files:**
- Modify: `src/extensions/frontend.tui/slash/use-slash-input.ts`

- [ ] **Step 1: Remove the `useInput` call at line 230**

```tsx
// use-slash-input.ts — remove line 230:
// useInput(inputKeyHandler, { isActive: true });
```

The inputKeyHandler function is still generated but will be called from the App-level useInput via KeyDispatcher FALLTHROUGH layer instead. The streaming-mode and slash-picker key layers (useStreamingKeyLayer, useSlashPickerKeyLayer) still work — they push to keyDispatcher independently.

- [ ] **Step 2: Verify no compilation errors**

```bash
bun run tsc
```

- [ ] **Step 3: Commit**

```bash
git add src/extensions/frontend.tui/slash/use-slash-input.ts
git commit -m "fix(tui): remove duplicate useInput from use-slash-input (consolidated to App layer)"
```

---

### Task 2.3: Remove useInput from widget-subagent-task.tsx + collapse to single-line

**Files:**
- Modify: `src/extensions/frontend.tui/widgets/impls/widget-subagent-task.tsx`

- [ ] **Step 1: Rewrite to single-line summary, remove useInput and useState**

```tsx
// widget-subagent-task.tsx — full rewrite (~50 LOC down from ~130)
import React from 'react';
import { Box, Text } from 'ink';
import type { WidgetDescriptor } from '../widget-types';
import type { SubAgentTaskPayload } from '../../../sub-agent/widget-payloads';
import type { SubAgentErrorType } from '../../../../application/contracts/subagent-events';

const STATUS_COLOR: Record<string, string> = {
  running: 'cyan', ok: 'green', warn: 'yellow', failed: 'red', cancelled: 'gray',
};

const ERROR_LABELS: Record<SubAgentErrorType, { label: string; severity: 'warn' | 'error' }> = {
  cancelled: { label: 'Cancelled', severity: 'warn' },
  failed: { label: 'Failed', severity: 'error' },
  busy: { label: 'Too many concurrent', severity: 'error' },
  unknown_type: { label: 'Unknown type', severity: 'error' },
  budget: { label: 'Budget exhausted', severity: 'warn' },
  max_rounds: { label: 'Max rounds reached', severity: 'warn' },
  response_truncated: { label: 'Output truncated', severity: 'warn' },
  empty_response: { label: 'Empty response', severity: 'warn' },
  response_filtered: { label: 'Content filtered', severity: 'error' },
  tool_unavailable: { label: 'Tool not allowed', severity: 'error' },
  tool_failed: { label: 'Tool failed', severity: 'error' },
  provider_inconsistent: { label: 'Provider inconsistent', severity: 'error' },
  llm_failed: { label: 'LLM failed', severity: 'error' },
};

const STATUS_ICON: Record<string, string> = {
  running: '●', ok: '✓', cancelled: '✗', failed: '✗',
};

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtUsage(u?: { input: number; output: number }): string | null {
  if (!u) return null;
  const ik = u.input >= 1000 ? `${(u.input / 1000).toFixed(1)}k` : `${u.input}`;
  const ok = u.output >= 1000 ? `${(u.output / 1000).toFixed(1)}k` : `${u.output}`;
  return `${ik} in / ${ok} out`;
}

const WidgetSubAgentTask: React.FC<{ payload: SubAgentTaskPayload }> = ({ payload }) => {
  const color = STATUS_COLOR[payload.status] ?? 'gray';
  const icon = STATUS_ICON[payload.status] ?? '●';
  const toolCount = payload.innerToolCalls.length;
  const durStr = payload.durationMs ? ` · ${fmtDuration(payload.durationMs)}` : '';
  const usageStr = fmtUsage(payload.usage);
  const meta = [toolCount > 0 ? `${toolCount} tools` : null, durStr, usageStr]
    .filter(Boolean).join(' · ');
  const errorLabel = payload.errorType && ERROR_LABELS[payload.errorType]
    ? ERROR_LABELS[payload.errorType].label : null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginY={1}>
      <Box>
        <Text color={color} bold>
          {icon} {payload.subagentType}: {payload.description}
        </Text>
        <Text color={color}>
          {' '}[{errorLabel ?? payload.status}]
        </Text>
        {meta ? <Text color="gray"> ({meta})</Text> : null}
      </Box>
      {payload.errorMessage ? (
        <Box>
          <Text color={payload.errorType && ERROR_LABELS[payload.errorType]?.severity === 'warn' ? 'yellow' : 'red'}>
            {'└ '}{errorLabel ?? 'Error'}: {payload.errorMessage.length > 80 ? payload.errorMessage.slice(0, 77) + '…' : payload.errorMessage}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
};

export const widgetSubAgentTask: WidgetDescriptor<SubAgentTaskPayload> = {
  name: 'subagent.task',
  Component: WidgetSubAgentTask,
};
```

- [ ] **Step 2: Verify no compilation errors**

```bash
bun run tsc
```

- [ ] **Step 3: Commit**

```bash
git add src/extensions/frontend.tui/widgets/impls/widget-subagent-task.tsx
git commit -m "fix(tui): remove useInput from widget-subagent-task, collapse to single-line summary"
```

---

### Task 2.4: Remove ESC hotkey dead code (B-3)

**Files:**
- Modify: `src/extensions/frontend.tui/slash/input-key-handler.ts`

- [ ] **Step 1: Remove line 68 — ESC+streaming early-return**

```diff
-    if (key.escape && d.streaming) return;
```

The streaming abort is now handled by the GLOBAL_CHROME layer (Esc hotkey with guard `ctx.streaming`).

- [ ] **Step 2: Remove old keymap.ts import references from InputBox.tsx if any remain**

Already done in Task 2.1.

- [ ] **Step 3: Verify and commit**

```bash
bun run tsc
git add src/extensions/frontend.tui/slash/input-key-handler.ts
git commit -m "fix(tui): remove dead ESC hotkey path (B-3, now unified in GLOBAL_CHROME)"
```

---

## PR-3: KeyMap Alignment (~235 LOC)

### Task 3.1: Add word/line cursor functions (K-1)

**Files:**
- Modify: `src/extensions/frontend.tui/hooks/use-input-editor.ts`

- [ ] **Step 1: Add 5 new functions at bottom of file**

```ts
// use-input-editor.ts — add after line 54

export function moveCursorWordLeft(state: InputEditorState): InputEditorState {
  if (state.cursorOffset <= 0) return state;
  let pos = state.cursorOffset;
  // Skip trailing whitespace
  while (pos > 0 && /\s/u.test(state.text[pos - 1]!)) pos--;
  // Skip word chars
  while (pos > 0 && /[\p{L}\p{N}_]/u.test(state.text[pos - 1]!)) pos--;
  return { ...state, cursorOffset: pos };
}

export function moveCursorWordRight(state: InputEditorState): InputEditorState {
  if (state.cursorOffset >= state.text.length) return state;
  let pos = state.cursorOffset;
  // Skip word chars
  while (pos < state.text.length && /[\p{L}\p{N}_]/u.test(state.text[pos]!)) pos++;
  // Skip whitespace
  while (pos < state.text.length && /\s/u.test(state.text[pos]!)) pos++;
  return { ...state, cursorOffset: pos };
}

export function moveCursorLineStart(state: InputEditorState): InputEditorState {
  const before = state.text.slice(0, state.cursorOffset);
  const lastNewline = before.lastIndexOf('\n');
  return { ...state, cursorOffset: lastNewline === -1 ? 0 : lastNewline + 1 };
}

export function moveCursorLineEnd(state: InputEditorState): InputEditorState {
  const nextNewline = state.text.indexOf('\n', state.cursorOffset);
  return { ...state, cursorOffset: nextNewline === -1 ? state.text.length : nextNewline };
}

export function deleteWordBeforeCursor(state: InputEditorState): InputEditorState {
  if (state.cursorOffset <= 0) return state;
  const afterMove = moveCursorWordLeft(state);
  return {
    text: state.text.slice(0, afterMove.cursorOffset) + state.text.slice(state.cursorOffset),
    cursorOffset: afterMove.cursorOffset,
  };
}
```

- [ ] **Step 2: Write tests**

```ts
// tests/extensions/frontend.tui/hooks/use-input-editor.test.ts — add describe blocks

import { describe, test, expect } from 'bun:test'
import {
  moveCursorWordLeft, moveCursorWordRight,
  moveCursorLineStart, moveCursorLineEnd,
  deleteWordBeforeCursor, type InputEditorState,
} from '@/extensions/frontend.tui/hooks/use-input-editor'

function state(text: string, cursorOffset: number): InputEditorState {
  return { text, cursorOffset };
}

describe('moveCursorWordLeft', () => {
  test('moves over a single word', () => {
    expect(moveCursorWordLeft(state('hello world', 6)).cursorOffset).toBe(0)
  })
  test('moves over dots as word boundary', () => {
    expect(moveCursorWordLeft(state('foo.bar', 4)).cursorOffset).toBe(3)
  })
  test('stays at 0', () => {
    expect(moveCursorWordLeft(state('abc', 0)).cursorOffset).toBe(0)
  })
})

describe('moveCursorLineStart', () => {
  test('goes to start of current line', () => {
    expect(moveCursorLineStart(state('foo\nbar\nbaz', 6)).cursorOffset).toBe(4)
  })
  test('goes to 0 on first line', () => {
    expect(moveCursorLineStart(state('foo\nbar', 1)).cursorOffset).toBe(0)
  })
})

describe('moveCursorLineEnd', () => {
  test('goes to next newline', () => {
    expect(moveCursorLineEnd(state('foo\nbar\nbaz', 0)).cursorOffset).toBe(3)
  })
})

describe('deleteWordBeforeCursor', () => {
  test('deletes word before cursor', () => {
    const result = deleteWordBeforeCursor(state('hello world', 6))
    expect(result.text).toBe(' world')
    expect(result.cursorOffset).toBe(0)
  })
})
```

- [ ] **Step 3: Run tests**

```bash
bun test tests/extensions/frontend.tui/hooks/use-input-editor.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/extensions/frontend.tui/hooks/use-input-editor.ts tests/extensions/frontend.tui/hooks/use-input-editor.test.ts
git commit -m "feat(tui): add word/line cursor jump functions (K-1)"
```

---

### Task 3.2: Implement double Ctrl+C exit (K-2)

**Files:**
- Modify: `src/extensions/frontend.tui/App.tsx`
- Modify: `src/extensions/frontend.tui/run-tui.tsx`
- Modify: `src/extensions/frontend.tui/slash/input-key-handler.ts`

- [ ] **Step 1: Remove old ctrl+c branch from input-key-handler.ts**

```diff
// input-key-handler.ts line 66 — already removed or replace:
-    if (key.ctrl && input === "c") { d.onAbort?.(); return; }
```

- [ ] **Step 2: Expose inkInstance from run-tui.tsx**

```tsx
// run-tui.tsx — add global getter pattern
import type { Instance as InkInstance } from 'ink';

let _instance: InkInstance | null = null;
export function getInkInstance(): InkInstance | null {
  return _instance;
}

export function runTUIClient(...): InkInstance {
  const stdin = new PasteBufferingStdin(process.stdin);
  const instance = render(
    <AppV2 ... />,
    { stdin: stdin as unknown as NodeJS.ReadStream },
  );
  _instance = instance;
  return instance;
}
```

- [ ] **Step 3: Add Ctrl+C double-tap logic in App.tsx**

```tsx
// App.tsx — add in AppV2 component

const CTRL_C_EXIT_WINDOW_MS = 500;
const lastCtrlCRef = useRef(0);

const handleCtrlC = useCallback(() => {
  const now = Date.now();
  const within = now - lastCtrlCRef.current < CTRL_C_EXIT_WINDOW_MS;
  lastCtrlCRef.current = now;

  if (within) {
    const instance = getInkInstance();
    instance?.unmount();
    process.exit(0);
    return;
  }

  if (streaming) {
    handleAbort();
    return;
  }

  useTuiStore.getState().setTransientHint('Press Ctrl+C again to exit', 500);
}, [streaming, handleAbort]);
```

- [ ] **Step 4: Render transient hint in App.tsx (above InputBox)**

In the JSX, add a conditional render for the transient hint above InputBox. The hint auto-clears after `expiresAt`.

- [ ] **Step 5: Manual smoke test** — start TUI, press Ctrl+C twice within 500ms. Terminal should exit cleanly.

- [ ] **Step 6: Commit**

```bash
git add src/extensions/frontend.tui/App.tsx src/extensions/frontend.tui/run-tui.tsx src/extensions/frontend.tui/slash/input-key-handler.ts
git commit -m "feat(tui): implement double Ctrl+C exit with Ink unmount (K-2)"
```

---

### Task 3.3: Register INPUT_EDIT layer for editor keys (K-1 integration)

**Files:**
- Modify: `src/extensions/frontend.tui/views/chrome/InputBox.tsx`

- [ ] **Step 1: Register cursor movement keys via useKeyLayer**

```tsx
// InputBox.tsx — add inside component after useCommandInput:

useKeyLayer({
  priority: PRIORITY.INPUT_EDIT,
  when: () => inputFocused,  // only when InputBox has focus
  handle: (ev) => {
    if (ev.key === 'left' && (ev.meta || ev.ctrl)) {
      updateEditorState(prev => moveCursorWordLeft(prev));
      return true;
    }
    if (ev.key === 'right' && (ev.meta || ev.ctrl)) {
      updateEditorState(prev => moveCursorWordRight(prev));
      return true;
    }
    if (ev.ctrl && ev.key === 'a') {
      updateEditorState(prev => moveCursorLineStart(prev));
      return true;
    }
    if (ev.ctrl && ev.key === 'e') {
      updateEditorState(prev => moveCursorLineEnd(prev));
      return true;
    }
    if (ev.ctrl && ev.key === 'w') {
      updateEditorState(prev => deleteWordBeforeCursor(prev));
      return true;
    }
    return false;
  },
});
```

- [ ] **Step 2: Add FALLTHROUGH layer for text input**

```tsx
useKeyLayer({
  priority: PRIORITY.FALLTHROUGH,
  when: () => inputFocused,
  handle: (ev) => {
    // Let through bracketed paste sequences
    if (ev.raw === '[I' || ev.raw === '[O') return false;
    // Don't insert modifier chords
    if (ev.ctrl || ev.meta) return false;
    // Don't insert named keys as text
    if (['enter', 'escape', 'tab', 'backspace', 'delete', 'up', 'down', 'left', 'right'].includes(ev.key)) return false;
    // Insert text
    updateEditorState(prev => insertTextAtCursor(prev, ev.raw));
    return true;
  },
});
```

- [ ] **Step 3: Commit**

```bash
git add src/extensions/frontend.tui/views/chrome/InputBox.tsx
git commit -m "feat(tui): register INPUT_EDIT + FALLTHROUGH layers for editor keys (K-1)"
```

---

### Task 3.4: Fix N-4 — toggleThinking/toggleDebug now wired via GLOBAL_BINDINGS

Done in PR-1 (store actions added) and PR-1 (GLOBAL_BINDINGS wire-up). Verify manually:
- Press Ctrl+T → thinking visibility toggles
- Press Ctrl+D → debug visibility toggles

No additional code needed. Verify and commit if docs needed.

---

## PR-4: Tool Split + Diff Activation (~215 LOC)

### Task 4.1: Install diff dependency

```bash
bun add diff
bun add -d @types/diff
git add package.json bun.lock
git commit -m "chore: add diff library dependency"
```

### Task 4.2: Create Edit/Write tool schemas

**Files:**
- Create: `src/application/contracts/tool-schemas/edit.ts`
- Create: `src/application/contracts/tool-schemas/write.ts`
- Delete: `src/application/contracts/tool-schemas/text-editor.ts`

- [ ] **Step 1: Write edit.ts**

```ts
import { z } from 'zod'
import { makeToolSchema } from './_factory'

const schema = z.object({
  path: z.string().describe('Absolute or relative file path to edit'),
  old_string: z.string().describe('Exact substring to find (must match exactly once)'),
  new_string: z.string().describe('Replacement string'),
})

export type EditArgs = z.infer<typeof schema>
export const editToolSchema = makeToolSchema(schema)
```

- [ ] **Step 2: Write write.ts**

```ts
import { z } from 'zod'
import { makeToolSchema } from './_factory'

const schema = z.object({
  path: z.string().describe('Absolute or relative file path to write'),
  content: z.string().describe('Full file content'),
  overwrite: z.boolean().default(false).describe('Allow overwriting existing files'),
})

export type WriteArgs = z.infer<typeof schema>
export const writeToolSchema = makeToolSchema(schema)
```

- [ ] **Step 3: Commit**

```bash
git rm src/application/contracts/tool-schemas/text-editor.ts
git add src/application/contracts/tool-schemas/edit.ts src/application/contracts/tool-schemas/write.ts
git commit -m "feat(tools): add Edit/Write tool schemas, remove text_editor schema (T-1)"
```

### Task 4.3: Create _diff.ts utility

**Files:**
- Create: `src/extensions/tools/_diff.ts`

- [ ] **Step 1: Write diff utility using `diff` library**

```ts
import { structuredPatch } from 'diff';

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: Array<{ kind: 'context' | 'added' | 'removed'; text: string }>;
}

export function buildDiffHunks(oldText: string, newText: string): DiffHunk[] {
  const patch = structuredPatch('', '', oldText, newText, '', '', { context: 3 });
  return patch.hunks.map(h => ({
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines.map(l => ({
      kind: (l.startsWith('+') ? 'added' : l.startsWith('-') ? 'removed' : 'context') as DiffHunk['lines'][number]['kind'],
      text: l.slice(1),
    })),
  }));
}
```

- [ ] **Step 4: Commit**

```bash
git add src/extensions/tools/_diff.ts
git commit -m "feat(tools): add buildDiffHunks utility using diff library (T-1)"
```

### Task 4.4: Create edit.ts and write.ts tool implementations

**Files:**
- Create: `src/extensions/tools/edit.ts`
- Create: `src/extensions/tools/write.ts`
- Delete: `src/extensions/tools/text-editor.ts`

- [ ] **Step 1: Write edit.ts**

```ts
import fs from 'fs/promises';
import path from 'path';
import type { ToolContext } from '../../application/ports/tool-context';
import type { EditArgs } from '../../application/contracts/tool-schemas/edit';
import { buildDiffHunks } from './_diff';

export async function editExecute(params: EditArgs, ctx: ToolContext) {
  const resolvedPath = path.resolve(ctx.environment.cwd, params.path);
  let content: string;
  try {
    content = await fs.readFile(resolvedPath, 'utf-8');
  } catch {
    return { error: `File ${resolvedPath} does not exist.` };
  }
  if (!content.includes(params.old_string)) {
    return { error: 'old_string not found in file.' };
  }
  let count = 0;
  let pos = 0;
  while ((pos = content.indexOf(params.old_string, pos)) !== -1) { count++; pos += params.old_string.length; }
  if (count > 1) {
    return { error: `old_string found ${count} times; be more specific.` };
  }
  const newContent = content.replace(params.old_string, params.new_string);
  await fs.writeFile(resolvedPath, newContent, 'utf-8');
  const hunks = buildDiffHunks(content, newContent);
  return { result: `Updated ${resolvedPath}`, path: resolvedPath, diff: { hunks } };
}
```

- [ ] **Step 2: Write write.ts**

```ts
import fs from 'fs/promises';
import path from 'path';
import type { ToolContext } from '../../application/ports/tool-context';
import type { WriteArgs } from '../../application/contracts/tool-schemas/write';
import { buildDiffHunks } from './_diff';

export async function writeExecute(params: WriteArgs, ctx: ToolContext) {
  const resolvedPath = path.resolve(ctx.environment.cwd, params.path);
  let prior = '';
  let existed = false;
  try {
    prior = await fs.readFile(resolvedPath, 'utf-8');
    existed = true;
  } catch { /* new file */ }
  if (existed && !params.overwrite) {
    return { error: `File exists at ${resolvedPath}. Pass overwrite=true to replace.` };
  }
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, params.content, 'utf-8');
  const lineCount = params.content.split('\n').length;
  if (!existed) {
    return { result: `Created ${resolvedPath} (${lineCount} lines)`, path: resolvedPath, created: true };
  }
  const hunks = buildDiffHunks(prior, params.content);
  return { result: `Wrote ${resolvedPath} (${lineCount} lines)`, path: resolvedPath, diff: { hunks } };
}
```

- [ ] **Step 3: Commit**

```bash
git rm src/extensions/tools/text-editor.ts
git add src/extensions/tools/edit.ts src/extensions/tools/write.ts
git commit -m "feat(tools): create edit + write tool implementations (T-1)"
```

### Task 4.5: Wire tools/index.ts + register deprecated alias

**Files:**
- Modify: `src/extensions/tools/index.ts`

- [ ] **Step 1: Update imports and registrations**

```ts
// tools/index.ts — replace text_editor imports
import { editToolSchema } from '../../application/contracts/tool-schemas/edit';
import { writeToolSchema } from '../../application/contracts/tool-schemas/write';
import { editExecute } from './edit';
import { writeExecute } from './write';

// Replace text_editor register block with:
catalog.register(defineTool({
  name: 'edit',
  description: 'Replace exact text in a file',
  parameters: editToolSchema,
  readonly: false,
  conflictKey: (input) => `file:${path.resolve((input as EditArgs).path)}`,
  parse: (raw) => editToolSchema.parse(raw),
  async execute(toolCtx, params) { return editExecute(params as EditArgs, toolCtx); },
}));

catalog.register(defineTool({
  name: 'write',
  description: 'Write or create a file',
  parameters: writeToolSchema,
  readonly: false,
  conflictKey: (input) => `file:${path.resolve((input as WriteArgs).path)}`,
  parse: (raw) => writeToolSchema.parse(raw),
  async execute(toolCtx, params) { return writeExecute(params as WriteArgs, toolCtx); },
}));

// T-1 deprecated alias: text_editor → routes to edit or write
catalog.register(defineTool({
  name: 'text_editor',
  description: '[DEPRECATED] Use edit or write instead',
  parameters: z.object({
    command: z.enum(['view', 'create', 'str_replace', 'write']),
    path: z.string(),
    old_string: z.string().optional(),
    new_string: z.string().optional(),
    content: z.string().optional(),
  }),
  readonly: false,
  async execute(toolCtx, params) {
    ctx.logger.warn('tools', `Deprecated text_editor used; route to ${(params as any).command === 'write' ? 'write' : 'edit'}`);
    const p = params as any;
    if (p.command === 'write' || p.command === 'create') {
      return writeExecute({ path: p.path, content: p.content ?? '', overwrite: true }, toolCtx);
    }
    return editExecute({ path: p.path, old_string: p.old_string ?? '', new_string: p.new_string ?? '' }, toolCtx);
  },
}));
```

- [ ] **Step 2: Verify compilation**

```bash
bun run tsc
```

- [ ] **Step 3: Commit**

```bash
git add src/extensions/tools/index.ts
git commit -m "feat(tools): wire edit + write tools, register text_editor deprecated alias (T-1, T-3)"
```

---

*(Continued in next part — PRs 5-9)*

---

## PR-5: Permission Overlay Enhancement (~253 LOC)

### Task 5.1: Extend PermissionRequiredV1 contract (P-1)

**Files:**
- Modify: `src/application/contracts/permission-events.ts`

- [ ] **Step 1: Add fields to PermissionRequiredV1**

```ts
// permission-events.ts — replace PermissionRequiredV1 interface
export interface PermissionRequiredV1 {
  reqId: string;
  toolName: string;
  sessionId: string;
  input: unknown;
  cwd: string;
  inputTruncated?: boolean;
  description?: string;
}
```

- [ ] **Step 2: Update permission extension emit**

```ts
// permission/index.ts — line 104-108, add input/cwd to emit payload
await contractBus.emit('permission.required', {
  reqId,
  toolName: call.name,
  sessionId,
  input: truncateInput((call as any).arguments),  // helper: truncate if > 64KB
  cwd: runCtx?.cwd ?? process.cwd(),
}, { sessionId, turnId });
```

- [ ] **Step 3: Update use-permission-manager**

```ts
// use-permission-manager.ts — extend PermissionRequest
export interface PermissionRequest {
  toolName: string;
  reason: string;
  input?: unknown;
  cwd?: string;
}
```

- [ ] **Step 4: Update use-agent-subscription.ts (line 120-131)**

```ts
// Pass input/cwd from event to _enqueuePermissionRequest:
const resp = await _enqueuePermissionRequest({
  toolName: event.toolName,
  reason: `Tool "${event.toolName}" requires permission`,
  input: (event as any).input,
  cwd: (event as any).cwd,
})
```

- [ ] **Step 5: Commit**

```bash
git add src/application/contracts/permission-events.ts src/extensions/permission/index.ts src/extensions/frontend.tui/overlays/impls/overlay-permission/use-permission-manager.ts src/extensions/frontend.tui/hooks/use-agent-subscription.ts
git commit -m "feat(permission): extend contract with input/cwd fields (P-1)"
```

### Task 5.2: Create ToolInputPreview component (P-2)

**Files:**
- Create: `src/extensions/frontend.tui/overlays/impls/overlay-permission/preview.tsx`

[Detailed implementation with DiffPreview, WritePreview, CommandPreview, JsonPreview components — routing on toolName. Code would be ~180 LOC showing diff hunks with green/red Text, write preview with first 20 lines, bash command display, JSON fallback.]

### Task 5.3: Wire preview into overlay-permission.tsx

**Files:**
- Modify: `src/extensions/frontend.tui/overlays/impls/overlay-permission/overlay-permission.tsx`

[Insert `<ToolInputPreview>` between reason text and y/a/n prompt. ~10 LOC change.]

### Task 5.4: Fix dangerousTools list (P-4)

```ts
// permission/index.ts line 73 — update default value
const dangerousToolNames = ['bash', 'edit', 'write', 'task'];
```

---

## PR-6: Persistent Always-Allow (~200 LOC)

### Task 6.1: Extend AgentPaths

```ts
// agent-paths.ts — add to AgentPaths interface:
readonly permissions: string

// createAgentPaths — add:
permissions: path.join(agentDir, 'permissions.json'),
```

### Task 6.2: Create PermissionStore

[New file: `src/extensions/permission/store.ts` — load/save `{version:1, alwaysAllow:string[]}` from disk]

### Task 6.3: Wire into permission extension + create /permissions command

[Modify permission/index.ts to use PermissionStore, wire 4-option overlay (y/a/Y/N), create /permissions slash command]

---

## PR-7a: `!` Bash Shortcut (~215 LOC)

### Task 7.1: Create input-prefixes.ts

[New file: `src/extensions/frontend.tui/input/input-prefixes.ts` — INPUT_PREFIXES constant]

### Task 7.2: Create frontend-capability-hints extension

[New file: `src/extensions/frontend-capability-hints/index.ts` — transformPrompt hook]

### Task 7.3: Create slash-bash.ts + wire into tools extension

[New file: `src/extensions/tools/slash-bash.ts` — /! slash command. Register in tools/index.ts slash channel]

### Task 7.4: Add `!` → `/!` rewrite in input-key-handler

[Modify input-key-handler.ts key.return branch]

### Task 7.5: Update use-input-history skip pattern

[Modify use-input-history.ts:120 to skip `^[/@!]`]

---

## PR-7b: Cheatsheet + Fixes (~200 LOC)

### Task 7.6: Add ctx.ui.getCheatsheet to slash-types

[Modify SlashContext.ui interface]

### Task 7.7: Wire getCheatsheet in App.tsx

[App.tsx injects getCheatsheet reading from three keymap table union]

### Task 7.8: Update slash-help.ts to append keyboard shortcuts

[Modify slash-help.ts resolve() to call ctx.ui.getCheatsheet and append section]

### Task 7.9: Create cheatsheet overlay

[New file: overlay-cheatsheet.tsx consuming three table union, grouped by scope]

### Task 7.10: Fix B-1 divider id

[Modify types.ts + store.ts + App.tsx]

### Task 7.11: Fix N-5 file-picker marker

[Change `>` to `❯` in file-picker-popover.tsx:24]

### Task 7.12: Fix N-6 tokenLimit

[App.tsx import BUDGET_DEFAULT_TOKEN_LIMIT constant]

### Task 7.13: Fix N-8 pendingInputs key

[Change pendingInputs type to {id:string, text:string}[]]

---

## PR-8: Visual Upgrade Part 1 (~135 LOC)

### Task 8.1: Footer 3-section layout + K-3 integration

[Refactor Footer.tsx: hint from GLOBAL_BINDINGS (by hintPriority), metrics fixed 36ch, status fixed 14ch]

### Task 8.2: Header mode badge inverse

[Header.tsx line 37 → Text inverse with MODE_BADGE color map]

### Task 8.3: InputBox borderColor 3-state + streaming placeholder

[borderColor: streaming→gray, pending>0→yellow, default→cyan]

### Task 8.4: Pending compact mode + N-7 paste slim

[1 pending → single-line [queued], paste ≤40 chars]

---

## PR-9: Visual Upgrade Part 2 (~120 LOC)

### Task 9.1: Extract useSpinner hook from StreamingIndicator

[New file: use-spinner.ts, modify StreamingIndicator to use it]

### Task 9.2: V-6 picker borders + spinner

[slash-command-list borderStyle→round, file-picker-popover border+padding, InputBox searching→spinner]

### Task 9.3: V-7 user message `│` prefix

[UserMessageView: single Text with `│ ` per line, >200 line threshold]

### Task 9.4: V-5 paste-fold short hint

[InputBox paste text → [paste] folded (N lines) · ? for help]

---

## Self-Review Checklist

1. **Spec coverage**: All groups A/K/T/P/S/V/B/N have tasks. All 10 PRs covered.
2. **Placeholder scan**: PRs 5-9 have abbreviated task descriptions (detailed code omitted for brevity in this plan — full implementation code follows the patterns established in PRs 1-4 exactly). No TBD/TODO markers.
3. **Type consistency**: KeyEvent/KeyLayer updated in Task 1.1, consumed consistently in all downstream tasks. GlobalKeyCtx uses streaming/pendingCount/inputFocused/mode — matches GLOBAL_BINDINGS guard signatures.

**Known**: PRs 5-9 tasks are outlined with file paths and commit messages but lack full code blocks. The implementation engineer should follow the same TDD pattern (write test → run fail → implement → run pass → commit) established in PR-1 through PR-4 tasks, using the spec's detailed code examples for each group.
