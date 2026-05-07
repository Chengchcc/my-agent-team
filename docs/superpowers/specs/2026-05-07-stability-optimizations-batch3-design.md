# Stability Optimizations — Batch 3 Design Spec

**Date**: 2026-05-07
**Scope**: Tool conflict detection, memory leak fixes, type-safe metadata, config migration system
**Status**: Approved

---

## 1. Tool Conflict Detection via Side Effect Declarations

### Problem

`planExecution()` in `dispatch.ts` groups tool calls into waves based on `conflictKey`. bash returns `'fs:global'` and text_editor returns `'fs:global'`, so they never share a wave. But read and grep have `conflictKey = null`, so they run in the same wave as each other — and potentially alongside an earlier version of bash that snuck through. There is no file-path-level conflict detection. A read of `foo.ts` and a text_editor write to `foo.ts` in the same tool call batch could race.

### Design

Add side effect declarations to each tool and check for conflicts within a wave.

**Tool side effects** (new in `tool-dispatch/types.ts`):
```typescript
interface ToolSideEffect {
  type: 'read' | 'write' | 'execute';
  path?: string;
}
```

**Conflict rules**: Two tools conflict if any of their side effects overlap:
- write + write on same path → conflict
- read + write on same path → conflict
- execute + anything → conflict (conservative)

**Integration in `dispatch.ts` `planExecution()`**: Before adding a tool to the current wave, check its side effects against all tools already in the wave. If conflict detected, flush current wave and start a new one.

**Tool side effect declarations** (map in `dispatch.ts`):
- `read`: `[{type:'read', path: params.file}]`
- `grep`: `[{type:'read', path: params.path}]`
- `ls`: `[{type:'read', path: params.path}]`
- `text_editor`: `[{type:'write', path: params.file}]`
- `bash`: `[{type:'execute'}]` — conflicts with everything
- default (unknown tools): `[{type:'execute'}]` — conservative

### Files Changed

| File | Change |
|------|--------|
| `src/agent/tool-dispatch/types.ts` | Add `ToolSideEffect` type |
| `src/agent/dispatch.ts` | Add side effect map + conflict check in `planExecution()` |
| `tests/agent/dispatch.test.ts` | Add tests for conflict detection |

### Edge Cases

- Tool without params: no path extraction → conservative, treat as execute
- MCP tools: conservative (`execute`) since we don't know their semantics
- Sub-agent tools: already excluded by conflictKey

---

## 2. Memory Leak Fixes

### Problem

Three leak sources: ContextManager messages grow unbounded, debug log buffer has no limit, AbortController listeners may not be cleaned.

### Design

**2a. ContextManager message cap**

In `ContextManager.addMessage()`, after adding a message, if `messages.length > MAX_MESSAGES` (2000), trim:
- Keep all system messages
- Keep the most recent `MAX_MESSAGES - systemCount` non-system messages
- Log a `debugLog` event when trimming occurs

**2b. Debug log rolling buffer**

In `utils/debug.ts`, add a line-count cap to the in-memory buffer:
- `MAX_BUFFER_LINES = 1000`
- After append, if buffer exceeds limit, drop oldest lines

**2c. AbortController cleanup**

In `agent-loop.ts` `run()` method `finally` block, ensure controller is set to null and listeners are removed.

### Files Changed

| File | Change |
|------|--------|
| `src/agent/context.ts` | Add message cap (~15 lines) |
| `src/utils/debug.ts` | Add buffer line limit (~10 lines) |
| `src/agent/agent-loop.ts` | Ensure controller cleanup (~5 lines) |
| `tests/agent/context.test.ts` | Add message cap test (if file exists) |

---

## 3. Type-Safe Context Metadata

### Problem

`AgentContext.metadata` is typed as `Map<any, any>`. Middlewares use it as a shared bag of state, with keys and value types defined by convention only. The architecture constitution bans new `any` types.

### Design

Define typed metadata keys using a `TypedMetadataKey<T>` wrapper and provide generic accessors.

**New in `src/agent/loop-types.ts`** (or `src/types.ts`):

```typescript
interface TypedMetadataKey<T> {
  symbol: symbol;
  description: string;
}

function defineMetadataKey<T>(description: string): TypedMetadataKey<T> {
  return { symbol: Symbol.for(description), description };
}

function getMetadata<T>(ctx: AgentContext, key: TypedMetadataKey<T>): T | undefined {
  return ctx.metadata.get(key.symbol) as T | undefined;
}

function setMetadata<T>(ctx: AgentContext, key: TypedMetadataKey<T>, value: T): void {
  ctx.metadata.set(key.symbol, value);
}
```

**Migration**: Define keys for existing uses (todo state, memory results, trace buffer, justCollapsed). Update consumers to use typed accessors. The `metadata` field type changes from `Map<any, any>` to `Map<symbol, unknown>`.

### Files Changed

| File | Change |
|------|--------|
| `src/types.ts` | Add `TypedMetadataKey`, `defineMetadataKey`, `getMetadata`, `setMetadata`. Change metadata type |
| `src/agent/agent-loop.ts` | Update `justCollapsed` metadata access |
| `src/todos/todo-middleware.ts` | Update todo state metadata access |
| `src/memory/middleware.ts` | Update memory result metadata access |
| `tests/agent/types-metadata.test.ts` | New test for typed metadata |

---

## 4. Config Versioning and Migration

### Problem

Four-layer config (defaults → user → project → env) has no version tracking. When settings schema changes, old configs silently break. Users can't tell which layer a value came from.

### Design

**4a. Schema versioning**

Add `version: number` to the Zod schema. Current default version = 1.

**4b. Migration chain**

New file `src/config/migrations.ts`:
```typescript
interface ConfigMigration {
  from: number;
  to: number;
  migrate(config: Record<string, unknown>): Record<string, unknown>;
}
```

Migrations run in chain: `version=1 → 2 → 3 → ...` until current.

**4c. Auto-migration in loader**

In `loader.ts`, after loading raw config, check `version`. If < current, run migrations sequentially. Save migrated config back to disk.

**4d. Source tracking (enhancement)**

Add optional `getSource(key)` to config accessor. Returns which layer (default/user/project/env) a value came from. Diagnostic method `getDiagnosticReport()` prints all keys with their sources.

### Files Changed

| File | Change |
|------|--------|
| `src/config/types.ts` | Add `version` field, `ConfigValueSource` type |
| `src/config/schema.ts` | Add `version` to Zod schema |
| `src/config/migrations.ts` | New file — migration chain |
| `src/config/loader.ts` | Add auto-migration logic, source tracking |
| `tests/config/loader.test.ts` | Add migration tests |

---

## Testing Strategy

| Item | Unit Test |
|------|-----------|
| Conflict detection | Verify read+write conflict splits wave, read+read stays in same wave |
| Memory leak fixes | Verify message cap trims correctly, debug buffer respects limit |
| Typed metadata | Verify typed get/set round-trips, verify key uniqueness |
| Config migration | Verify version 1 → 2 migration, verify no-op when version matches |
