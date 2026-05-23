# PR5: W6 — Panel registry (minimal infrastructure)

> Optional/low-priority. Creates the PanelDescriptor abstraction and registers Footer+StreamingIndicator as proof-of-pattern.

**Goal:** Introduce `PanelDescriptor<S>` + `PanelSlot` types, `PANELS` registry, and `PanelHost` component. Wire App.tsx to use registry instead of hardcoded `<Footer />` + `<StreamingIndicator />` mounts.

---

## File Map

| Action | Path | Purpose |
|---|---|---|
| CREATE | `src/extensions/frontend.tui/panels/panel-types.ts` | PanelDescriptor<S>, PanelSlot |
| CREATE | `src/extensions/frontend.tui/panels/panel-registry.ts` | PANELS array |
| CREATE | `src/extensions/frontend.tui/panels/panel-host.tsx` | PanelHost renders panels by slot |
| MODIFY | `src/extensions/frontend.tui/App.tsx` | Replace <Footer/>+<StreamingIndicator/> with <PanelHost/> |
| MODIFY | `scripts/check-architecture.ts` | A19.4 (panel registry completeness) |

---

## Task 1: Create panel-types.ts

```ts
// src/extensions/frontend.tui/panels/panel-types.ts
import type { ComponentType } from 'react'

export type PanelSlot = 'footer-left' | 'footer-right' | 'sidebar-left' | 'sidebar-right' | 'top-banner'

export interface PanelDescriptor<S = unknown> {
  readonly name: string
  readonly slot: PanelSlot
  readonly Component: ComponentType<{ state: S }>
  readonly subscribe: (setState: (s: S) => void) => () => void
}
```

## Task 2: Create panel-registry.ts

Create `PANELS` array. Footer goes to `footer-left`, StreamingIndicator to `footer-right`. Both subscribe to the zustand store directly.

## Task 3: Create panel-host.tsx

Renders panels grouped by slot. Footer slot gets a horizontal flex row.

## Task 4: Update App.tsx

Replace hardcoded `<Footer />` + `<StreamingIndicator />` with `<PanelHost />`.

## Task 5: Add A19.4 guard

Optional — panel registry is advisory at this stage.

## Task 6: Verify

```bash
bun run check:guard + check:arch + test
```
