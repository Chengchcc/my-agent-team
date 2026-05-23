# PR3: W3 — TodoPanel→widget.todo.list 端到端验证

> Pure verification PR — proves Widget system works end-to-end with a real ext.

**Goal:** Migrate TodoPanel from hardcoded store-subscribing component to Widget data flow (emitInlineBlock → dataplane → FinalItem.widget → FinalItemView → lookupWidget → WidgetTodoList). Reference implementation for all future ext widget PRs.

**Architecture:** Skills ext owns the payload type. TUI renders the component. Data flows via tui.inline-block dataplane events.

---

## Pre-PR3 Verification

```bash
bun run check:guard    # must be zero
bun run check:arch     # must be zero violations  
bun test               # must be 580 pass
```

## File Map

| Action | Path | Purpose |
|---|---|---|
| CREATE | `src/extensions/skills/widget-payloads.ts` | TodoListPayload + declare module |
| MODIFY | `src/extensions/frontend.tui/widgets/widget-registry.ts` | Uncomment skills import + add WIDGETS entry |
| REWRITE | `src/extensions/frontend.tui/widgets/impls/widget-todo-list.tsx` | Store subscription → payload-injected component |
| MODIFY | `src/extensions/frontend.tui/App.tsx` | Remove hardcoded TodoPanel mount; inject widget events from store subscription |
| MODIFY | `src/extensions/frontend.tui/state/store.ts` | (if needed) Ensure widget events can be appended to transcript |

---

## Task 1: Create skills widget-payloads.ts

**Files:**
- Create: `src/extensions/skills/widget-payloads.ts`

- [ ] **Step 1: Create type-only payload file**

```ts
// src/extensions/skills/widget-payloads.ts

/** Widget payload for the todo list inline block. */
export interface TodoListPayload {
  readonly todos: ReadonlyArray<{
    readonly id: string
    readonly text: string
    readonly status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  }>
}

declare module '../../application/contracts/widget-payload-map' {
  interface WidgetPayloadMap {
    'skills.todo-list': TodoListPayload
  }
}
```

- [ ] **Step 2: Verify A19.3 + A19.6 pass**

```bash
bun run check:arch
```
Expected: A19.3 (type-only) and A19.6 (declare module) pass for this file. A19.7 will FAIL because widget-registry hasn't added the side-effect import yet — expected, will fix in Task 2.

## Task 2: Update widget-registry.ts

**Files:**
- Modify: `src/extensions/frontend.tui/widgets/widget-registry.ts`

- [ ] **Step 1: Read current widget-registry.ts**

Note the current empty `WIDGETS: WidgetMap = {}` declaration.

- [ ] **Step 2: Add side-effect import**

Uncomment (or add) the skills import:
```ts
import '../../../skills/widget-payloads'
```

- [ ] **Step 3: Import widget descriptor**

```ts
import { widgetTodoList } from './impls/widget-todo-list'
```

- [ ] **Step 4: Add WIDGETS entry**

Replace `export const WIDGETS: WidgetMap = {}` with:
```ts
export const WIDGETS: WidgetMap = {
  'skills.todo-list': widgetTodoList,
}
```

TypeScript will now enforce that `widgetTodoList` matches `WidgetDescriptor<TodoListPayload>`.

- [ ] **Step 5: Verify A19.7 passes**

```bash
bun run check:arch
```
Expected: A19.7 (side-effect import) now passes for skills.

## Task 3: Rewrite widget-todo-list.tsx

**Files:**
- Rewrite: `src/extensions/frontend.tui/widgets/impls/widget-todo-list.tsx`

- [ ] **Step 1: Read current implementation**

Note the current store subscription pattern (likely `useStore` or zustand selector).

- [ ] **Step 2: Rewrite as pure payload-injected component**

Remove ALL store imports. Rewrite to accept `{ payload: TodoListPayload }`:

```tsx
import React from 'react'
import { Box, Text } from 'ink'
import type { WidgetDescriptor } from '../widget-types'
import type { TodoListPayload } from '../../../skills/widget-payloads'

const STATUS_ICONS: Record<string, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '✓',
  cancelled: '✗',
}

const WidgetTodoList: React.FC<{ payload: TodoListPayload }> = ({ payload }) => {
  if (payload.todos.length === 0) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text dimColor>No todo items.</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" paddingY={1}>
      <Text bold>Todo ({payload.todos.length})</Text>
      {payload.todos.map(todo => (
        <Text key={todo.id}>
          {STATUS_ICONS[todo.status] ?? '?'} {todo.text}
        </Text>
      ))}
    </Box>
  )
}

export const widgetTodoList: WidgetDescriptor<TodoListPayload> = {
  name: 'skills.todo-list',
  Component: WidgetTodoList,
}
```

- [ ] **Step 3: Type check**

```bash
bun run check:guard
```

## Task 4: Update App.tsx — remove hardcoded mount

**Files:**
- Modify: `src/extensions/frontend.tui/App.tsx`

- [ ] **Step 1: Read App.tsx and find current TodoPanel usage**

Search for: `WidgetTodoList`, `TodoPanel`, `todo` imports. Find where the component is rendered.

- [ ] **Step 2: Read the store to understand todo state**

Read `src/extensions/frontend.tui/state/store.ts`. Find todo-related state/actions. Understand when todos change.

- [ ] **Step 3: Replace hardcoded mount with widget event injection**

Remove the `<WidgetTodoList ...>` JSX element from App.tsx.

Instead, subscribe to todo state changes and inject widget items into the transcript. The approach depends on how the store works. Look at how `genKey` generates keys — it already has `widget-${item.blockId}` support from PR1.

Option A (if App.tsx has access to transcript/committed items):
```tsx
// Subscribe to todo changes, inject as widget event
useEffect(() => {
  const todos = getTodoItems() // whatever the current pattern is
  store.appendWidget({
    blockId: 'todo-list',
    widget: 'skills.todo-list',
    payload: { todos },
    mode: 'replace',  // replaces previous todo widget with same blockId
  })
}, [todoState])
```

Option B (if daemon-side emit exists):
Find the skills ext or tool that creates todos, call `emitInlineBlock` there.

For PR3, prefer Option A if it keeps the TUI working. The goal is proving the pipeline works, not perfecting the data source.

- [ ] **Step 4: Ensure SlashResolution render-widget is wired**

Find the `case 'render-widget'` in App.tsx (added in PR2 follow-up). Wire it to call `store.appendWidget(...)` with the resolution's widget/payload/blockId.

## Task 5: Final Verification

- [ ] **Step 1: Type check**

```bash
bun run check:guard
```

- [ ] **Step 2: Architecture check**

```bash
bun run check:arch
```
Expected: ZERO violations.

- [ ] **Step 3: Tests**

```bash
bun test 2>&1 | tail -3
```
Expected: 580 pass, 0 fail.

- [ ] **Step 4: Verify widget pipeline compiles**

```bash
# Confirm the full chain exists:
grep -n "skills.todo-list" src/application/contracts/widget-payload-map.ts  # (declared via merge — won't appear directly)
grep -n "skills.todo-list" src/extensions/skills/widget-payloads.ts         # exists
grep -n "skills.todo-list" src/extensions/frontend.tui/widgets/widget-registry.ts  # exists in WIDGETS
grep -n "import.*skills/widget-payloads" src/extensions/frontend.tui/widgets/widget-registry.ts  # side-effect import
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(widget): PR3 — todo widget end-to-end (skills.todo-list)

- Add skills/widget-payloads.ts with TodoListPayload + declare module
- Register skills.todo-list in WIDGETS with WidgetTodoList component
- Rewrite WidgetTodoList as pure payload-injected component
- Remove hardcoded TodoPanel mount from App.tsx
- Wire store todo subscription → widget event injection
- Wire SlashResolution render-widget → store.appendWidget
- Proves Widget data flow end-to-end for all future ext widgets

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```
