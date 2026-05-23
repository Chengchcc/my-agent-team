# PR7: W7.x — Ext Widget Integration (trace + memory + evolution)

> Follows the PR3 reference pattern for each ext: widget-payloads.ts → widget impl → registry → slash ext.

**Goal:** Add inline widget rendering for 3 extensions (trace/memory/evolution). Each ext gets a payload type, a TUI widget component, and a slash command that returns `render-widget`. MCP is CLI-only (no widget).

**Pattern (per ext):**
1. `extensions/<ext>/widget-payloads.ts` — type-only payload + declare module
2. `frontend.tui/widgets/impls/widget-<ext>-<name>.tsx` — pure component
3. `widget-registry.ts` — uncomment side-effect import + add WIDGETS entry
4. `frontend.tui/slash/ext/slash-<ext>.ts` — slash command via RPC → render-widget
5. App.tsx — register ext slash in SlashRegistry (or via EXT_SLASHES array)

---

## File Map

### Create
```
src/extensions/trace/widget-payloads.ts
src/extensions/memory/widget-payloads.ts
src/extensions/evolution/widget-payloads.ts
src/extensions/frontend.tui/widgets/impls/widget-trace-show.tsx
src/extensions/frontend.tui/widgets/impls/widget-memory-list.tsx
src/extensions/frontend.tui/widgets/impls/widget-evolution-proposals.tsx
src/extensions/frontend.tui/slash/ext/slash-trace.ts
src/extensions/frontend.tui/slash/ext/slash-memory.ts
src/extensions/frontend.tui/slash/ext/slash-evolution.ts
```

### Modify
```
src/extensions/frontend.tui/widgets/widget-registry.ts  ← 3 side-effect imports + 3 WIDGETS entries
src/extensions/frontend.tui/App.tsx                       ← register ext slashes
```

---

## Task 1: trace widget (trace.show)

### 1a. Create trace/widget-payloads.ts

```ts
export interface TraceShowPayload {
  readonly run: {
    readonly id: string
    readonly sessionId: string
    readonly events: ReadonlyArray<{
      readonly type: string
      readonly timestamp: string
    }>
  }
}

declare module '../../../application/contracts/widget-payload-map' {
  interface WidgetPayloadMap {
    'trace.show': TraceShowPayload
  }
}
```

### 1b. Create widget-trace-show.tsx

Simple component showing trace run events in a bordered box.

### 1c. Create slash/ext/slash-trace.ts

Slash command: `/trace show <runId>` → calls `trace.getRun` RPC → returns `render-widget`.

## Task 2: memory widget (memory.list)

### 2a. Create memory/widget-payloads.ts

```ts
export interface MemoryListPayload {
  readonly entries: ReadonlyArray<{
    readonly id: string
    readonly type: string
    readonly text: string
    readonly weight: number
  }>
}

declare module '../../../application/contracts/widget-payload-map' {
  interface WidgetPayloadMap {
    'memory.list': MemoryListPayload
  }
}
```

### 2b. Create widget-memory-list.tsx

Renders memory entries with type badge and text preview.

### 2c. Create slash/ext/slash-memory.ts

Slash: `/memory list` → RPC `memory.list` → render-widget. `/memory search <q>` → RPC `memory.search` → render-widget.

## Task 3: evolution widget (evolution.proposals)

### 3a. Create evolution/widget-payloads.ts

```ts
export interface EvolutionProposalsPayload {
  readonly proposals: ReadonlyArray<{
    readonly id: string
    readonly tier: string
    readonly outcome: string
    readonly skillName?: string
    readonly reasoning: string
    readonly createdAt: number
  }>
}

declare module '../../../application/contracts/widget-payload-map' {
  interface WidgetPayloadMap {
    'evolution.proposals': EvolutionProposalsPayload
  }
}
```

### 3b. Create widget-evolution-proposals.tsx

Renders proposals with tier badge and truncated reasoning.

### 3c. Create slash/ext/slash-evolution.ts

Slash: `/evolution list` → RPC `evolution.listProposals` → render-widget. `/evolution stats` → text output.

## Task 4: Update widget-registry.ts

Uncomment 3 side-effect imports + add 3 WIDGETS entries.

## Task 5: Update App.tsx

Register ext slashes in the useMemo SlashRegistry block.

## Task 6: Verify

```bash
bun run check:guard      # zero type errors
bun run check:arch       # A19.7 side-effect import check passes
bun test 2>&1 | tail -3   # all pass
```
