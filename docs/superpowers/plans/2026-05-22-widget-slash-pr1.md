# PR1: W1+W2 — Widget Infrastructure + Naming Cleanup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development

**Goal:** Clean 4 component names, create Widget contract infrastructure (WidgetPayloadMap skeleton, emitInlineBlock, InlineBlockV1, FinalItem.widget variant, widget-registry with side-effect import zone, A19.1/.2/.3/.6/.7 guards).

**Architecture:** Contracts remain leaf nodes (empty interface + declare module). TUI side creates widget-types + widget-registry. No ext changes yet. All type-only, zero runtime behavior change.

**Tech Stack:** TypeScript, React, Ink, Bun

---

## File Map

### W1 — Naming Cleanup (4 files + FilePicker conditional)

| Action | Path | Purpose |
|---|---|---|
| MOVE+RENAME | `components/TodoPanel.tsx` → `widgets/impls/widget-todo-list.tsx` | Rename + re-categorize |
| MOVE+RENAME | `components/SessionPicker.tsx` → `overlays/impls/overlay-session-picker.tsx` | Rename + re-categorize |
| MOVE+RENAME | `components/ReviewNotification.tsx` → `overlays/impls/overlay-review-notification.tsx` | Rename + re-categorize |
| MOVE+RENAME | `components/SlashCommandList.tsx` → `slash/components/slash-command-list.tsx` | Rename + move to slash domain |
| CONDITIONAL | `components/FilePicker.tsx` | Rename to `components/file-picker-popover.tsx` if NOT modal overlay; to `overlays/impls/overlay-file-picker.tsx` if IS modal overlay. PR实施时读代码判定 |
| KEEP | `components/CodeBlock.tsx`, `components/HighlightedInput.tsx`, `components/utils/` | Pure rendering primitives, not in any widget/overlay/slash category |

### W2 — Widget Contract Infrastructure

| Action | Path | Purpose |
|---|---|---|
| CREATE | `src/application/contracts/widget-payload-map.ts` | Empty WidgetPayloadMap interface |
| CREATE | `src/application/contracts/widget-events.ts` | InlineBlockV1 + emitInlineBlock helper |
| MODIFY | `src/application/contracts/events/contracted-event-map.ts` | Add `tui.inline-block` entry |
| MODIFY | `src/application/contracts/index.ts` | Export new widget types |
| CREATE | `src/extensions/frontend.tui/widgets/widget-types.ts` | WidgetDescriptor interface |
| CREATE | `src/extensions/frontend.tui/widgets/widget-registry.ts` | WIDGETS (empty) + lookupWidget + side-effect import zone |
| MODIFY | `src/extensions/frontend.tui/transcript/from-dataplane.ts` | Add `tui.inline-block` case → FinalItem `widget` variant |
| MODIFY | `src/extensions/frontend.tui/state/types.ts` | Add `{ kind: 'widget', ... }` to FinalItem union |
| MODIFY | `src/extensions/frontend.tui/views/final/FinalItemView.tsx` | Add widget rendering branch via lookupWidget |
| MODIFY | `scripts/check-architecture.ts` | Add A19.1/.2/.3/.6/.7 guard rules |

---

## Task 1: W1 — Naming Cleanup

### Task 1.1: Move TodoPanel → widget-todo-list

**Files:**
- Move: `src/extensions/frontend.tui/components/TodoPanel.tsx` → `src/extensions/frontend.tui/widgets/impls/widget-todo-list.tsx`
- Update: all imports referencing TodoPanel

- [ ] **Step 1: Create target directories**

```bash
mkdir -p src/extensions/frontend.tui/widgets/impls
mkdir -p src/extensions/frontend.tui/overlays/impls
mkdir -p src/extensions/frontend.tui/slash/components
```

- [ ] **Step 2: Move and rename file**

Read `TodoPanel.tsx` first. Then move it and update the component name:
```bash
mv src/extensions/frontend.tui/components/TodoPanel.tsx src/extensions/frontend.tui/widgets/impls/widget-todo-list.tsx
```

In the moved file, rename:
- Component: `TodoPanel` → `WidgetTodoList`
- Export: match component name

- [ ] **Step 3: Update all imports**

Search for all files importing `from '...TodoPanel'` or `from '...components/TodoPanel'`. Update to `from '...widgets/impls/widget-todo-list'` and update the imported symbol name.

- [ ] **Step 4: Verify**

```bash
bun run check:guard
```
Expected: PASS (or only pre-existing issues)

### Task 1.2: Move SessionPicker → overlay-session-picker

Same process. Update component name `SessionPicker` → `OverlaySessionPicker`. Update all imports.

### Task 1.3: Move ReviewNotification → overlay-review-notification

Same process. Update component name `ReviewNotification` → `OverlayReviewNotification`. Update all imports.

### Task 1.4: Move SlashCommandList → slash-command-list

Move `components/SlashCommandList.tsx` → `slash/components/slash-command-list.tsx`. Update all imports. Component can keep name or add `Slash` prefix.

### Task 1.5: FilePicker — conditional rename

Read `components/FilePicker.tsx`. Check if it:
- Uses modal patterns (blocks input, requires Esc to dismiss) → move to `overlays/impls/overlay-file-picker.tsx`
- Is an inline popover/dropdown → rename to `components/file-picker-popover.tsx`

Update all imports accordingly.

### Task 1.6: Verify W1

```bash
bun run check:guard
bun test 2>&1 | tail -3
```
All tests pass. No bare `*Panel.tsx`/`*Picker.tsx` in widgets/overlays/panels dirs.

---

## Task 2: W2 — Widget Contract Infrastructure

### Task 2.1: Create widget-payload-map.ts

Create `src/application/contracts/widget-payload-map.ts`:

```ts
/**
 * WidgetPayloadMap — Single Source of Truth for widget name ↔ payload shape.
 *
 * Extensions enhance this via declare module in their widget-payloads.ts files.
 * TUI's widget-registry.ts uses keyof WidgetPayloadMap to type-check WIDGETS.
 *
 * Adding a widget:
 *   1. ext: widget-payloads.ts — define payload + declare module
 *   2. contracts: （自动合并，无需改动）
 *   3. TUI: widget-registry.ts add side-effect import + WIDGETS entry
 *
 * A19.6 + A19.7 enforce all three stay in sync.
 */
export interface WidgetPayloadMap {
  // Intentionally empty — enhanced by extensions via declare module
}

export type WidgetName = keyof WidgetPayloadMap

export type WidgetPayloadFor<W extends WidgetName> = WidgetPayloadMap[W]
```

### Task 2.2: Create widget-events.ts

Create `src/application/contracts/widget-events.ts`:

```ts
import { createEvent } from './event-envelope'
import type { WidgetName, WidgetPayloadFor } from './widget-payload-map'

let nextBlockId = 0

export interface InlineBlockV1 {
  readonly type: 'tui.inline-block'
  readonly v: 1
  readonly sessionId: string
  readonly blockId: string
  readonly widget: WidgetName
  readonly payload: unknown          // serialized; emitter-side typed via emitInlineBlock
  readonly mode: 'append' | 'replace'
  readonly ts: number
}

/**
 * Emit a typed inline-block event on the contract bus.
 * WidgetName + payload are type-checked against WidgetPayloadMap.
 */
export function emitInlineBlock<W extends WidgetName>(
  bus: { emit(event: string, payload: unknown): void },
  args: {
    sessionId: string
    widget: W
    payload: WidgetPayloadFor<W>
    blockId?: string
    mode?: 'append' | 'replace'
  },
): void {
  const blockId = args.blockId ?? `inline-${++nextBlockId}`
  const event: InlineBlockV1 = {
    type: 'tui.inline-block',
    v: 1,
    sessionId: args.sessionId,
    blockId,
    widget: args.widget,
    payload: args.payload as unknown,
    mode: args.mode ?? 'append',
    ts: Date.now(),
  }
  bus.emit('tui.inline-block', createEvent('tui.inline-block', event, {
    sessionId: args.sessionId,
  }))
}
```

### Task 2.3: Update ContractedEventMap

Read `src/application/contracts/events/contracted-event-map.ts`. Add import and entry:

```ts
import type { InlineBlockV1 } from '../widget-events'

// In ContractedEventMap interface:
  'tui.inline-block': InlineBlockV1
```

### Task 2.4: Create widget-types.ts

Create `src/extensions/frontend.tui/widgets/widget-types.ts`:

```ts
import type { ComponentType } from 'react'

export interface WidgetDescriptor<P = unknown> {
  readonly name: string
  readonly Component: ComponentType<{ payload: P }>
}
```

### Task 2.5: Create widget-registry.ts

Create `src/extensions/frontend.tui/widgets/widget-registry.ts`:

```ts
// Side-effect imports — load ext widget-payloads.ts so their declare module
// blocks merge into WidgetPayloadMap. Required because:
//   1. tsc only merges declarations of files in program
//   2. tsconfig include catches them by default, but we don't rely on it
//   3. A19.7 enforces this list stays in sync with payload files
//
// verbatimModuleSyntax preserves these imports verbatim — they hit Bun's
// loader at runtime, execute zero code (payloads are type-only modules).
// Per-ext side-effect imports go here (W7.x uncomments each):
// import '../../../memory/widget-payloads'
// import '../../../trace/widget-payloads'
// import '../../../skills/widget-payloads'
// import '../../../evolution/widget-payloads'

import type { WidgetName, WidgetPayloadFor } from '../../../application/contracts/widget-payload-map'
import type { WidgetDescriptor } from './widget-types'

type WidgetMap = { [W in WidgetName]: WidgetDescriptor<WidgetPayloadFor<W>> }

/** Empty initially — ext widget impls added in W3/W7.x. */
export const WIDGETS: WidgetMap = {} as WidgetMap

export function lookupWidget(name: string): WidgetDescriptor | null {
  return (WIDGETS as Record<string, WidgetDescriptor>)[name] ?? null
}
```

### Task 2.6: Add FinalItem.widget variant

Read `src/extensions/frontend.tui/state/types.ts`. Add to FinalItem union:

```ts
  | { kind: 'widget'; blockId: string; widget: string; payload: unknown; mode: 'append' | 'replace' }
```

### Task 2.7: Add from-dataplane case

Read `src/extensions/frontend.tui/transcript/from-dataplane.ts`. Find the event→FinalItem mapping. Add:

```ts
case 'tui.inline-block':
  return {
    kind: 'widget',
    blockId: event.blockId,
    widget: event.widget,
    payload: event.payload,
    mode: event.mode,
  }
```

### Task 2.8: Add FinalItemView widget branch

Read `src/extensions/frontend.tui/views/final/FinalItemView.tsx`. Add:

```tsx
import { lookupWidget } from '../../widgets/widget-registry'

// In the render switch/if-else chain:
if (item.kind === 'widget') {
  const w = lookupWidget(item.widget)
  if (!w) return <Text color="red">[unknown widget: {item.widget}]</Text>
  return <w.Component payload={item.payload as never} />
}
```

### Task 2.9: Add A19 guards to check-architecture.ts

Read `scripts/check-architecture.ts`. Add after existing A18 section:

```ts
// ── A19: Widget system guards ──────────────────────────────────────────

// A19.1 — every widget declared in WidgetPayloadMap must be in WIDGETS
// (TS types enforce this already; text scan is backup against @ts-ignore bypass)
function extractWidgetNames(path: string): string[] {
  try {
    const src = readFileSync(path, 'utf8')
    const re = /'([^']+)'\s*[?:]\s*\w+Payload/g
    return [...src.matchAll(re)].map(m => m[1]!)
  } catch { return [] }
}

// A19.2 — ext must not import ink/react (only frontend.tui may)
const jsxImporters = grep(/from ['"](ink|react)['"]/, 'src/extensions/')
for (const f of jsxImporters) {
  if (!f.startsWith('src/extensions/frontend.tui/')) {
    fail(`A19.2: only frontend.tui may import ink/react: ${f}`)
  }
}

// A19.3 — widget-payloads.ts must be type-only (no const/let/var/function/class)
const payloadFiles = glob('src/extensions/*/widget-payloads.ts')
for (const f of payloadFiles) {
  const src = readFileSync(f, 'utf8')
  if (/^(const|let|var|function|class)\s/m.test(src)) {
    fail(`A19.3: ${f} must be type-only (no runtime code)`)
  }
}

// A19.6 — widget-payloads.ts must contain declare module of widget-payload-map
for (const f of payloadFiles) {
  const src = readFileSync(f, 'utf8')
  if (!/declare\s+module\s+['"][^'"]*widget-payload-map/.test(src)) {
    fail(`A19.6: ${f} must contain declare module of widget-payload-map`)
  }
}

// A19.7 — widget-registry.ts must side-effect import every widget-payloads.ts
if (payloadFiles.length > 0) {
  const registry = readFileSync('src/extensions/frontend.tui/widgets/widget-registry.ts', 'utf8')
  for (const f of payloadFiles) {
    const extName = f.split('/')[2]!  // 'memory' from 'src/extensions/memory/widget-payloads.ts'
    const expected = `'../../../${extName}/widget-payloads'`
    if (!registry.includes(expected)) {
      fail(`A19.7: widget-registry.ts must side-effect import ${extName}/widget-payloads`)
    }
  }
}
```

### Task 2.10: Update contracts/index.ts

Read `src/application/contracts/index.ts`. Add exports:

```ts
export type { WidgetPayloadMap, WidgetName, WidgetPayloadFor } from './widget-payload-map'
export { emitInlineBlock } from './widget-events'
export type { InlineBlockV1 } from './widget-events'
```

---

## Task 3: Verify + Commit

- [ ] **Step 1: Type check**

```bash
bun run check:guard
```

- [ ] **Step 2: Architecture check**

```bash
bun run check:arch
```
Expected: A19 guards pass (A19.6/A19.7 silent because no widget-payloads.ts files exist yet).

- [ ] **Step 3: Tests**

```bash
bun test 2>&1 | tail -3
```
Expected: all pass, TUI visual behavior unchanged.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(widget): PR1 — W1 naming cleanup + W2 widget contract infrastructure

W1 — Naming cleanup:
- Rename TodoPanel → widget-todo-list (widgets/)
- Rename SessionPicker → overlay-session-picker (overlays/)
- Rename ReviewNotification → overlay-review-notification (overlays/)
- Rename SlashCommandList → slash-command-list (slash/components/)
- FilePicker conditional rename (popover or overlay, per impl review)

W2 — Widget contract infrastructure:
- Add WidgetPayloadMap (empty, ext-enhanced via declare module)
- Add emitInlineBlock helper + InlineBlockV1 contract event
- Add FinalItem.widget variant + from-dataplane case
- Add widget-types.ts + widget-registry.ts (empty WIDGETS)
- Add A19.1/.2/.3/.6/.7 architecture guards

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```
