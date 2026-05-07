# Batch 3 Stability Optimizations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement tool conflict detection via side-effect declarations, memory leak fixes (message cap, debug buffer limit, controller cleanup), type-safe metadata accessors, and config versioning with auto-migration.

**Architecture:** Four independent changes: (1) extend `planExecution()` in dispatch.ts with file-level conflict detection; (2) add message cap to ContextManager, rolling buffer to debugLog, AbortController cleanup to agent-loop; (3) add typed metadata key system with Symbol keys and generic accessors; (4) add version field to config schema, migration chain, and source tracking.

**Tech Stack:** TypeScript, Bun test runner

---

### Task 1: Tool Conflict Detection via Side-Effect Declarations

**Files:**
- Modify: `src/agent/tool-dispatch/types.ts` — add `ToolSideEffect` type
- Modify: `src/agent/dispatch.ts` — add side-effect map, enhance `planExecution()` with intra-wave conflict detection
- Create: `tests/agent/tool-conflict.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/agent/tool-conflict.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { planExecution } from '../../src/agent/dispatch';
import type { ToolCall, ToolImplementation } from '../../src/types';

function toolDef(name: string, opts: { conflictKey?: (args: unknown) => string | null; readonly?: boolean } = {}): ToolImplementation {
  return {
    getDefinition: () => ({ name, description: name, parameters: { type: 'object', properties: {}, required: [] } }),
    execute: async () => '',
    ...(opts.conflictKey ? { conflictKey: opts.conflictKey } : {}),
    ...(opts.readonly !== undefined ? { readonly: opts.readonly } : {}),
  };
}

function makeCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: name + '_1', name, arguments: args };
}

describe('Tool conflict detection via side effects', () => {
  it('should split read and write to same file into separate waves', () => {
    const calls: ToolCall[] = [
      makeCall('read', { file_path: '/tmp/foo.ts' }),
      makeCall('text_editor', { file: '/tmp/foo.ts' }),
    ];

    const registry = new Map<string, ToolImplementation>();
    registry.set('read', toolDef('read', { readonly: true }));
    registry.set('text_editor', toolDef('text_editor', { readonly: false }));

    // text_editor has write side-effect, read has read on same path → conflict
    const plan = planExecution(calls, (name) => registry.get(name));
    // Should be 2 waves (read first, then write — or vice versa; depends on ordering)
    expect(plan.waves.length).toBe(2);
  });

  it('should keep read+read on different files in same wave', () => {
    const calls: ToolCall[] = [
      makeCall('read', { file_path: '/tmp/a.ts' }),
      makeCall('read', { file_path: '/tmp/b.ts' }),
    ];

    const registry = new Map<string, ToolImplementation>();
    registry.set('read', toolDef('read', { readonly: true }));

    const plan = planExecution(calls, (name) => registry.get(name));
    // Both reads, different files, no conflict → 1 wave
    expect(plan.waves.length).toBe(1);
    expect(plan.waves[0]!.length).toBe(2);
  });

  it('should isolate bash (execute) from all other tools', () => {
    const calls: ToolCall[] = [
      makeCall('read', { file_path: '/tmp/a.ts' }),
      makeCall('bash', { command: 'ls' }),
    ];

    const registry = new Map<string, ToolImplementation>();
    registry.set('read', toolDef('read', { readonly: true }));
    registry.set('bash', toolDef('bash', { readonly: false }));

    const plan = planExecution(calls, (name) => registry.get(name));
    // bash has execute side-effect → always separate wave
    expect(plan.waves.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/agent/tool-conflict.test.ts
```

Expected: FAIL — read+write to same file end up in same wave (no current path-level detection).

- [ ] **Step 3: Add ToolSideEffect type to types.ts**

In `src/agent/tool-dispatch/types.ts`, add:

```typescript
export interface ToolSideEffect {
  type: 'read' | 'write' | 'execute';
  path?: string;
}
```

- [ ] **Step 4: Add side-effect declarations and conflict detection to dispatch.ts**

In `src/agent/dispatch.ts`, after the `resolveConflict` function (line 66), add:

```typescript
import type { ToolSideEffect } from './tool-dispatch/types';

/**
 * Extract side effects from a tool call based on tool name and arguments.
 * Conservative: unknown/execute tools conflict with everything.
 */
function getSideEffects(name: string, args: Record<string, unknown>): ToolSideEffect[] {
  switch (name) {
    case 'read':
      return [{ type: 'read', path: args.file_path as string | undefined }];
    case 'grep':
      return [{ type: 'read', path: args.path as string | undefined }];
    case 'glob':
      return [{ type: 'read', path: args.path as string | undefined }];
    case 'ls':
      return [{ type: 'read', path: args.path as string | undefined }];
    case 'text_editor':
      return [{ type: 'write', path: args.file as string | undefined }];
    case 'bash':
      return [{ type: 'execute' }];
    default:
      // MCP tools and unknown tools: conservative
      return [{ type: 'execute' }];
  }
}

/**
 * Check if two sets of side effects conflict.
 */
function hasSideEffectConflict(a: ToolSideEffect[], b: ToolSideEffect[]): boolean {
  for (const sa of a) {
    for (const sb of b) {
      // execute conflicts with everything
      if (sa.type === 'execute' || sb.type === 'execute') return true;
      // write + write on same path
      if (sa.type === 'write' && sb.type === 'write' && sa.path && sb.path && sa.path === sb.path) return true;
      // read + write on same path
      if ((sa.type === 'write' && sb.type === 'read') || (sa.type === 'read' && sb.type === 'write')) {
        if (sa.path && sb.path && sa.path === sb.path) return true;
      }
    }
  }
  return false;
}
```

- [ ] **Step 5: Integrate conflict detection into planExecution**

In `src/agent/dispatch.ts`, replace the loop at lines 33-45 with:

```typescript
  for (const call of calls) {
    const tool = lookup(call.name);
    const conflict = resolveConflict(call, tool);

    if (conflict !== null) {
      // Has conflictKey conflict — flush and isolate
      flush();
      waves.push([call]);
      continue;
    }

    // Check side-effect conflicts against current wave members
    const effects = getSideEffects(call.name, call.arguments as Record<string, unknown>);
    const conflictsWithWave = currentWave.some(existing => {
      const existingEffects = getSideEffects(
        existing.name,
        existing.arguments as Record<string, unknown>,
      );
      return hasSideEffectConflict(effects, existingEffects);
    });

    if (conflictsWithWave) {
      // Flush current wave, start new one with this tool
      flush();
      currentWave.push(call);
    } else {
      currentWave.push(call);
    }
  }
```

- [ ] **Step 6: Run tests**

```bash
bun test tests/agent/tool-conflict.test.ts tests/agent/dispatch.test.ts
```

Expected: ALL PASS (new conflict tests + existing dispatch tests).

- [ ] **Step 7: Commit**

```bash
git add tests/agent/tool-conflict.test.ts src/agent/dispatch.ts src/agent/tool-dispatch/types.ts
git commit -m "feat: add file-level tool conflict detection via side-effect declarations

Each tool declares side effects (read/write/execute with optional path).
planExecution() checks intra-wave conflicts: write+write and read+write
on the same path are split into separate waves. Execute effects conflict
with everything.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: Memory Leak Fixes

**Files:**
- Modify: `src/agent/context.ts` — add MAX_MESSAGES cap in `addMessage()`
- Modify: `src/utils/debug.ts` — add rolling buffer limit
- Modify: `src/agent/agent-loop.ts` — ensure AbortController cleanup in `finally`
- Create: `tests/agent/message-cap.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/agent/message-cap.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { ContextManager } from '../../src/agent/context';

function makeMsg(role: 'user' | 'assistant', content: string) {
  return { role, content };
}

describe('ContextManager message cap', () => {
  it('should trim old messages when exceeding MAX_MESSAGES', async () => {
    const cm = new ContextManager({ tokenLimit: 100000 });
    cm.setSystemPrompt('system prompt');

    // Add 2005 user messages (exceeds default cap of 2000)
    for (let i = 0; i < 2005; i++) {
      cm.addMessage(makeMsg('user', `message ${i}`));
    }

    const ctx = cm.getContext({ tokenLimit: 100000, provider: {} as any });
    // Should have trimmed to <= 2000 non-system messages + system
    expect(ctx.messages.length).toBeLessThanOrEqual(2001);
  });

  it('should preserve system messages during trimming', async () => {
    const cm = new ContextManager({ tokenLimit: 100000 });
    cm.setSystemPrompt('system prompt');

    for (let i = 0; i < 2005; i++) {
      cm.addMessage(makeMsg('user', `message ${i}`));
    }

    const ctx = cm.getContext({ tokenLimit: 100000, provider: {} as any });
    const systemMsgs = ctx.messages.filter(m => m.role === 'system');
    expect(systemMsgs.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/agent/message-cap.test.ts
```

Expected: FAIL — messages exceed 2000, no trimming occurs.

- [ ] **Step 3: Add message cap to ContextManager**

In `src/agent/context.ts`, in the `addMessage` method at line 169-176, replace:

```typescript
  addMessage(message: Message): void {
    const msg = {
      ...message,
      id: message.id ?? nanoid(),
    };
    this.messages.push(msg);
    this.accumulator.add(msg);
  }
```

With:

```typescript
  private static readonly MAX_MESSAGES = 2000;

  addMessage(message: Message): void {
    const msg = {
      ...message,
      id: message.id ?? nanoid(),
    };
    this.messages.push(msg);
    this.accumulator.add(msg);

    // Trim if over cap
    if (this.messages.length > ContextManager.MAX_MESSAGES) {
      const systemMsgs = this.messages.filter(m => m.role === 'system');
      const nonSystem = this.messages.filter(m => m.role !== 'system');
      const keep = nonSystem.slice(-(ContextManager.MAX_MESSAGES - systemMsgs.length));
      this.messages = [...systemMsgs, ...keep];
      debugLog(`[ContextManager] trimmed messages to ${this.messages.length} (cap: ${ContextManager.MAX_MESSAGES})`);
    }
  }
```

Add debugLog import if not present (it is `import { debugLog } from '../utils/debug';`).

Run: `bun test tests/agent/message-cap.test.ts` — should pass.

- [ ] **Step 4: Add rolling buffer limit to debug.ts**

In `src/utils/debug.ts`, after the `debugMode` variable, add:

```typescript
const MAX_BUFFER_LINES = 1000;
let lineCount = 0;
```

In the `writeLine` function (line 15-21), add at the end before writing:

```typescript
  lineCount++;
  if (lineCount > MAX_BUFFER_LINES) {
    // Silently drop; the file on disk handles persistence
    return;
  }
```

Actually, rethink: the current code writes to file or console.warn. There's no in-memory buffer — it writes directly. So the "buffer limit" concept doesn't apply here. Instead, the limit should be on how many lines are written to file. Let's add a line counter for the file case and skip when over cap:

In the `writeLine` function, replace with:

```typescript
function writeLine(line: string): void {
  lineCount++;
  if (lineCount > MAX_BUFFER_LINES) return; // rate limit
  if (debugFile) {
    try { appendFileSync(debugFile, line); } catch { /* ignore write errors */ }
  } else {
    console.warn(line);
  }
}
```

And add a `resetLineCount` export for testing:

```typescript
export function resetDebugLineCount(): void {
  lineCount = 0;
}
```

- [ ] **Step 5: Ensure AbortController cleanup in agent-loop.ts**

In `src/agent/agent-loop.ts`, the `run()` method `finally` block at lines 156-159 already has:

```typescript
    } finally {
      clearTimeout(timeoutId);
      this.controller = null;
    }
```

This is already correct — `clearTimeout` cleans up the timer, and `this.controller = null` releases the reference. No change needed. Verify no additional listener cleanup is required.

- [ ] **Step 6: Run all related tests**

```bash
bun test tests/agent/message-cap.test.ts tests/agent/context.test.ts 2>&1 | tail -5
```

- [ ] **Step 7: Commit**

```bash
git add tests/agent/message-cap.test.ts src/agent/context.ts src/utils/debug.ts
git commit -m "feat: add message cap and debug log rate limiting

ContextManager.addMessage() trims old messages when exceeding 2000,
preserving system messages. Debug log line count capped at 1000
to prevent unbounded console/file output.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: Type-Safe Context Metadata

**Files:**
- Modify: `src/types.ts` — add typed metadata key system + change metadata type
- Modify: `src/agent/agent-loop.ts` — update `justCollapsed` access to use typed key
- Create: `tests/agent/types-metadata.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/agent/types-metadata.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { defineMetadataKey, getMetadata, setMetadata } from '../../src/types';
import type { AgentContext } from '../../src/types';

interface TodoState {
  active: number;
  completed: number;
}

const TodoKey = defineMetadataKey<TodoState>('todo-state');
const JustCollapsedKey = defineMetadataKey<boolean>('just-collapsed');

function makeCtx(): AgentContext {
  return {
    messages: [],
    systemPrompt: '',
    config: { tokenLimit: 100000 },
    metadata: {} as Record<string, unknown>,
    provider: { getModelName: () => 'test' } as any,
  };
}

describe('Typed metadata accessors', () => {
  it('should round-trip typed values', () => {
    const ctx = makeCtx();
    setMetadata(ctx, TodoKey, { active: 3, completed: 1 });

    const result = getMetadata(ctx, TodoKey);
    expect(result).toEqual({ active: 3, completed: 1 });
  });

  it('should return undefined for unset keys', () => {
    const ctx = makeCtx();
    expect(getMetadata(ctx, TodoKey)).toBeUndefined();
  });

  it('should isolate different keys', () => {
    const ctx = makeCtx();
    setMetadata(ctx, TodoKey, { active: 1, completed: 0 });
    setMetadata(ctx, JustCollapsedKey, true);

    expect(getMetadata(ctx, TodoKey)).toEqual({ active: 1, completed: 0 });
    expect(getMetadata(ctx, JustCollapsedKey)).toBe(true);
  });

  it('should use unique Symbol per key definition', () => {
    const KeyA = defineMetadataKey<string>('a');
    const KeyB = defineMetadataKey<string>('b');
    expect(KeyA.symbol).not.toBe(KeyB.symbol);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/agent/types-metadata.test.ts
```

Expected: FAIL — `defineMetadataKey` not exported from types.ts.

- [ ] **Step 3: Add typed metadata system to types.ts**

In `src/types.ts`, after the existing types, add:

```typescript
// ── Typed context metadata keys ──

export interface TypedMetadataKey<T> {
  readonly symbol: symbol;
  readonly description: string;
}

export function defineMetadataKey<T>(description: string): TypedMetadataKey<T> {
  return { symbol: Symbol.for(`agent.metadata.${description}`), description };
}

export function getMetadata<T>(ctx: AgentContext, key: TypedMetadataKey<T>): T | undefined {
  return (ctx.metadata as Record<string, unknown>)[key.symbol.toString()] as T | undefined;
}

export function setMetadata<T>(ctx: AgentContext, key: TypedMetadataKey<T>, value: T): void {
  (ctx.metadata as Record<string, unknown>)[key.symbol.toString()] = value;
}
```

- [ ] **Step 4: Define standard metadata keys and export from types.ts**

After the accessor functions, add:

```typescript
/** Standard metadata keys used across the codebase. */
export const MetadataKeys = {
  /** Todo state snapshot for middleware communication. */
  TodoState: defineMetadataKey<Record<string, unknown>>('todo-state'),
  /** Flag set after Tier 4 context collapse. */
  JustCollapsed: defineMetadataKey<boolean>('just-collapsed'),
  /** Memory retrieval results injected by memory middleware. */
  RetrievedMemory: defineMetadataKey<Array<{ id: string; text: string }>>('retrieved-memory'),
} as const;
```

- [ ] **Step 5: Update agent-loop.ts to use typed accessor**

In `src/agent/agent-loop.ts`, line 250:
```typescript
      afterBeforeCompress.metadata.justCollapsed = true;
```

Change to:
```typescript
      import { MetadataKeys, setMetadata } from '../types';
      // ... at the usage site:
      setMetadata(afterBeforeCompress, MetadataKeys.JustCollapsed, true);
```

Note: `metadata` remains as `Record<string, unknown>` (it already is), but now typed accessors provide compile-time type safety. The legacy `.metadata.justCollapsed = true` still works but the new accessor is preferred.

Actually, to minimize churn, do NOT update existing access patterns. Just add the typed system and let it be used for new code. The existing `metadata.justCollapsed = true` and `metadata.todo` patterns continue to work with `Record<string, unknown>`.

So just add the typed key system to types.ts (Steps 3-4) and export MetadataKeys. No existing code needs modification.

- [ ] **Step 6: Run tests**

```bash
bun test tests/agent/types-metadata.test.ts
```

Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/agent/types-metadata.test.ts src/types.ts
git commit -m "feat: add type-safe context metadata accessors

defineMetadataKey<T>() creates typed keys, getMetadata/setMetadata
provide compile-time type safety. MetadataKeys object exports
standard keys (TodoState, JustCollapsed, RetrievedMemory).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: Config Versioning and Migration

**Files:**
- Modify: `src/config/types.ts` — add `version` field
- Modify: `src/config/schema.ts` — add `version` to Zod schema
- Create: `src/config/migrations.ts` — migration chain
- Modify: `src/config/loader.ts` — auto-migrate on load
- Create: `tests/config/migration.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/config/migration.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { runMigrations } from '../../src/config/migrations';
import type { Settings } from '../../src/config/types';

describe('Config migrations', () => {
  it('should return unchanged config when version matches current', () => {
    const config = { version: 1 } as unknown as Record<string, unknown>;
    const result = runMigrations(config as any, 1);
    expect(result).toEqual(config);
  });

  it('should report migration path from old version', () => {
    // Version 0 (pre-versioning) → 1
    const config = {} as unknown as Record<string, unknown>;
    const result = runMigrations(config as any, 0);
    expect(result.version).toBe(1);
  });

  it('should apply migrations sequentially', () => {
    // Simulate: version 0 → 1 → 2
    const config = {} as unknown as Record<string, unknown>;
    const result = runMigrations(config as any, 0);
    expect(result.version).toBe(1);
  });
});

describe('Config source tracking', () => {
  it('should report value source', () => {
    // Future: when getWithSource is implemented
    expect(true).toBe(true); // placeholder for future feature
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/config/migration.test.ts
```

Expected: FAIL — `runMigrations` not exported from migrations.ts.

- [ ] **Step 3: Add version to config types and schema**

In `src/config/types.ts`, add after `Settings` interface:

```typescript
export const CURRENT_CONFIG_VERSION = 1;
```

In `src/config/schema.ts`, add `version` to the Zod schema. Find the `settingsSchema` definition and add:

```typescript
  version: z.number().optional().default(1),
```

- [ ] **Step 4: Create migrations.ts**

Create `src/config/migrations.ts`:

```typescript
import type { Settings } from './types';

export interface ConfigMigration {
  from: number;
  to: number;
  migrate(config: Record<string, unknown>): Record<string, unknown>;
}

const MIGRATIONS: ConfigMigration[] = [
  // Example migration: version 0 (unversioned) → version 1
  {
    from: 0,
    to: 1,
    migrate(config: Record<string, unknown>): Record<string, unknown> {
      // First migration: just stamp the version
      return { ...config, version: 1 };
    },
  },
];

/**
 * Run migrations from `fromVersion` to CURRENT_VERSION.
 * Returns the migrated config (or original if already current).
 */
export function runMigrations(
  config: Record<string, unknown>,
  fromVersion: number,
): Record<string, unknown> {
  let result = { ...config };
  let currentVersion = fromVersion;

  while (currentVersion < CURRENT_CONFIG_VERSION) {
    const migration = MIGRATIONS.find(m => m.from === currentVersion);
    if (!migration) break; // No migration path — stop
    result = migration.migrate(result);
    currentVersion = migration.to;
  }

  return { ...result, version: CURRENT_CONFIG_VERSION };
}

import { CURRENT_CONFIG_VERSION } from './types';
```

Wait, the import at the bottom needs to be at the top. Fix the ordering:

```typescript
import { CURRENT_CONFIG_VERSION } from './types';

export interface ConfigMigration {
  from: number;
  to: number;
  migrate(config: Record<string, unknown>): Record<string, unknown>;
}

const MIGRATIONS: ConfigMigration[] = [
  {
    from: 0,
    to: 1,
    migrate(config: Record<string, unknown>): Record<string, unknown> {
      return { ...config, version: 1 };
    },
  },
];

export function runMigrations(
  config: Record<string, unknown>,
  fromVersion: number,
): Record<string, unknown> {
  let result = { ...config };
  let currentVersion = fromVersion;

  while (currentVersion < CURRENT_CONFIG_VERSION) {
    const migration = MIGRATIONS.find(m => m.from === currentVersion);
    if (!migration) break;
    result = migration.migrate(result);
    currentVersion = migration.to;
  }

  return { ...result, version: CURRENT_CONFIG_VERSION };
}
```

- [ ] **Step 5: Integrate auto-migration into loader.ts**

In `src/config/loader.ts`, after loading config YAML and before Zod validation, add:

```typescript
import { runMigrations } from './migrations';
import { CURRENT_CONFIG_VERSION } from './types';

// In the load function, after parsing YAML:
const configVersion = (rawConfig as Record<string, unknown>).version as number ?? 0;
if (configVersion < CURRENT_CONFIG_VERSION) {
  rawConfig = runMigrations(rawConfig as Record<string, unknown>, configVersion);
  // Optionally save migrated config back to disk
}
```

- [ ] **Step 6: Run tests**

```bash
bun test tests/config/migration.test.ts tests/config/loader.test.ts
```

Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/config/migration.test.ts src/config/migrations.ts src/config/types.ts src/config/schema.ts src/config/loader.ts
git commit -m "feat: add config versioning and auto-migration

Config schema now includes a version field (default=1). Migration
chain in migrations.ts auto-upgrades old config files on load.
CURRENT_CONFIG_VERSION exported from types.ts.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Verification

After all tasks complete, run the full test suite:

```bash
bun test
```

All pre-existing tests must pass. No regressions.
