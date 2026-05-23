# PR4: W5 — Overlay registry + ext hook reorganization

> Refactors the modal overlay system from scattered hooks+views into a unified OverlayDescriptor registry.

**Goal:** Extract `usePermissionManager` + `useAskUserQuestionManager` from `hooks/` C3 category into overlay subdirectories. Introduce `OverlayDescriptor<Req, Res>` + `useOverlayStack` as the standard overlay abstraction. All existing behavior preserved.

**Architecture:** Each overlay = one subdirectory in `overlays/impls/<name>/` containing `overlay-<name>.tsx` (Component), `use-<name>-manager.ts` (protocol hook), and optional `types.ts`.

---

## File Map

| Action | Path | Purpose |
|---|---|---|
| CREATE | `src/extensions/frontend.tui/overlays/overlay-types.ts` | OverlayDescriptor<Req, Res> |
| CREATE | `src/extensions/frontend.tui/overlays/use-overlay-stack.ts` | LIFO overlay stack hook |
| CREATE | `src/extensions/frontend.tui/overlays/overlay-registry.ts` | OVERLAYS registry |
| CREATE | `src/extensions/frontend.tui/overlays/impls/overlay-permission/overlay-permission.tsx` | Move from views/overlay/PermissionPrompt.tsx |
| CREATE | `src/extensions/frontend.tui/overlays/impls/overlay-permission/use-permission-manager.ts` | Move from hooks/ |
| CREATE | `src/extensions/frontend.tui/overlays/impls/overlay-ask-user-question/overlay-ask-user-question.tsx` | Move from views/overlay/AskUserQuestionPrompt.tsx |
| CREATE | `src/extensions/frontend.tui/overlays/impls/overlay-ask-user-question/use-ask-user-question-manager.ts` | Move from hooks/ |
| DELETE | `src/extensions/frontend.tui/views/overlay/` | Migrated to overlays/impls/ |
| DELETE | `src/extensions/frontend.tui/hooks/use-permission-manager.ts` | Moved |
| DELETE | `src/extensions/frontend.tui/hooks/use-ask-user-question-manager.ts` | Moved |
| MODIFY | `src/extensions/frontend.tui/App.tsx` | Use overlay stack instead of individual hooks |
| MODIFY | `scripts/check-architecture.ts` | A19.5 (overlay registry) + A19.8 (hooks/ no ext protocols) |

---

## Task 1: Create overlay-types.ts

Create `src/extensions/frontend.tui/overlays/overlay-types.ts`:

```ts
import type { ComponentType } from 'react'

export interface OverlayDescriptor<Req = unknown, Res = unknown> {
  readonly name: string
  readonly Component: ComponentType<{
    request: Req
    respond: (response: Res) => void
    dismiss: () => void
  }>
}

export interface OverlayEntry<Req = unknown, Res = unknown> {
  descriptor: OverlayDescriptor<Req, Res>
  request: Req
  resolve: (res: Res) => void
  reject: (err: Error) => void
}
```

## Task 2: Create use-overlay-stack.ts

Create `src/extensions/frontend.tui/overlays/use-overlay-stack.ts`:

```ts
import { useState, useCallback } from 'react'
import type { OverlayDescriptor, OverlayEntry } from './overlay-types'

export function useOverlayStack() {
  const [stack, setStack] = useState<OverlayEntry[]>([])

  const push = useCallback(<Req, Res>(
    descriptor: OverlayDescriptor<Req, Res>,
    request: Req,
  ): Promise<Res> => {
    return new Promise((resolve, reject) => {
      setStack(prev => [...prev, { descriptor, request, resolve, reject } as OverlayEntry])
    })
  }, [])

  const pop = useCallback(() => {
    setStack(prev => prev.slice(0, -1))
  }, [])

  return { stack, push, pop }
}
```

## Task 3: Move overlays + hooks into impls/ subdirectories

For each of the two overlays (permission, ask-user-question):

1. Create target directory: `overlays/impls/overlay-<name>/`
2. Move the view component from `views/overlay/<Name>Prompt.tsx` → `overlays/impls/overlay-<name>/overlay-<name>.tsx`
3. Move the manager hook from `hooks/use-<name>-manager.ts` → `overlays/impls/overlay-<name>/use-<name>-manager.ts`
4. Update ALL imports in ALL files — especially App.tsx
5. Rename component: `<Name>Prompt` → `Overlay<Name>` (e.g. `PermissionPrompt` → `OverlayPermission`)
6. Export an `OverlayDescriptor` from the component file

## Task 4: Update App.tsx

Replace individual hook calls (`usePermissionManager` + `useAskUserQuestionManager`) and individual `<PermissionPrompt />` + `<AskUserQuestionPrompt />` JSX with the overlay stack pattern:

```tsx
import { useOverlayStack } from './overlays/use-overlay-stack'
import { overlayPermission } from './overlays/impls/overlay-permission/overlay-permission'
import { overlayAskUserQuestion } from './overlays/impls/overlay-ask-user-question/overlay-ask-user-question'

// Replace:
//   const { permissionRequest, respondToPermission } = usePermissionManager()
//   const { askUserQuestionRequest, respondWithAnswers } = useAskUserQuestionManager()
// With:
//   const overlayStack = useOverlayStack()

// Render:
//   {overlayStack.stack.length > 0 && (
//     <overlayStack.stack[overlayStack.stack.length - 1].descriptor.Component
//       request={overlayStack.stack[overlayStack.stack.length - 1].request}
//       respond={...}
//       dismiss={overlayStack.pop}
//     />
//   )}
```

NOTE: The current hooks use global singleton managers that are stubs (empty subscribe/respond). The overlay stack should maintain backward compatibility — the managers can still use the global singleton pattern internally. Don't break anything.

## Task 5: Add A19.5 + A19.8 guards

Add to `scripts/check-architecture.ts`:

```ts
// A19.5 — overlay descriptors must be registered in overlays/impls/
// A19.8 — hooks/ must not contain ext protocol names (permission, ask-user-question, etc.)
const hookFiles = project.getSourceFiles('src/extensions/frontend.tui/hooks/*.ts')
const EXT_PROTOCOL_PATTERNS = /request\.permission|request\.ask-user-question|permission\.|ask.user.question/i
for (const f of hookFiles) {
  if (EXT_PROTOCOL_PATTERNS.test(f.getFullText())) {
    v(`A19.8: ${f.getFilePath()} contains ext protocol patterns — must live in overlays/impls/<name>/`)
  }
}
```

## Task 6: Verify

```bash
bun run check:guard      # zero type errors
bun run check:arch       # zero violations  
bun test 2>&1 | tail -3   # all pass
find src/extensions/frontend.tui/views/overlay/ -type f  # should be empty/removed
find src/extensions/frontend.tui/hooks/ -name 'use-permission*' -o -name 'use-ask*'  # should be empty
```

Commit at end.
