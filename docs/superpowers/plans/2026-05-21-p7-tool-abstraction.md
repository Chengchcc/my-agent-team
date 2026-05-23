# P-7: Tool Abstraction + ControlPlane Contracts + Abort End-to-End

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Contract-wrap all controlplane raw emits, replace ZodTool abstract class with `defineTool` factory + central `ToolCatalog`, and wire abort signal end-to-end from TUI Esc to provider/tool/turn-runner.

**Architecture:** Three sequential tracks. Track A (contracts) is independent. Track B (tool refactor) establishes `defineTool` factory, `ToolCatalog` extension (enforce: pre), `dispatch-tool` usecase, `ToolExecutor` port, and migrates all 11 ZodTool-dependent classes to the new system. Track C (abort) layers `AbortController` management into the session extension and wires the signal through `run-turn.ts` → provider + dispatch-tool + turn-runner.

**Tech Stack:** TypeScript, Zod (contracts + tools/internal only), Bun test

**Locked Decisions (from grill-me):**
1. Track A: 12 raw emits all contract-wrapped (5 future-wire events get contracts now)
2. MCP `ToolRegistry` class deleted; all tools register to central `ToolCatalog`
3. `~20` line `zodToJsonSchema` helper covering only types used by 9 builtin tools
4. All 9 tools in `tools/` migrated; 3 dead ones (web-search, web-fetch, ask-user-question) activated
5. `ToolContext` constructed in `run-turn.ts`, `cwd` from `ctx.profileDir`
6. Execution order: Track A → Track B → Track C
7. `MemoryTool` and `CreateReviewSkillTool` deleted (zero consumers, dead code)
8. Abort MVP: turn-runner checks `signal.aborted` between iterations; tools do NOT internally check signal
9. MCP static tools → `defineTool`; `McpToolAdapter`/`McpPromptTool` → dynamic `catalog.register()`/`unregister()`
10. `extensions/tools/` flattened (no `tools/tools/` nesting); schema + execute co-located per file
11. `onToolCall` hook moves from `tools` extension to `tool-catalog` extension
12. `types.ts` re-exports deleted outright (no deprecated shim)

---

## File Structure

### New files (9)

| File | Responsibility |
|------|---------------|
| `src/application/contracts/system-events.ts` | 5 new event contracts (AttachChangedV1, SessionResumedV1, SessionClosedV1, SessionRenamedV1, UserQuestionAnsweredV1, SystemShutdownRequestedV1, InputCancelledV1, TurnCancelledV1) |
| `src/application/ports/tool.ts` | Unified `Tool` interface (merged Tool + ToolImplementation) |
| `src/application/ports/tool-executor.ts` | `ToolExecutor` port interface |
| `src/application/tool-factory/define-tool.ts` | `defineTool()` factory function |
| `src/application/tool-catalog/in-memory-catalog.ts` | `InMemoryCatalog` — default `ToolCatalog` implementation |
| `src/application/usecases/dispatch-tool.ts` | `dispatchTool()` orchestration usecase |
| `src/infrastructure/tool/in-process-executor.ts` | `InProcessExecutor` — default `ToolExecutor` impl |
| `src/extensions/tool-catalog/index.ts` | `tool-catalog` extension (enforce: pre) |
| `src/extensions/tools/parse-with-zod.ts` | `parseWithZod()` / `zodToJsonSchema()` helpers (~25 lines) |

### Modified files (14)

| File | Change |
|------|--------|
| `src/application/contracts/session-events.ts` | Add `SessionCreatedV1` fields needed by controlplane |
| `src/application/contracts/events/contracted-event-map.ts` | +8 event mappings (14→22) |
| `src/extensions/controlplane/methods.ts` | 12 raw emit → contractBus; `session.created` emit payload fix; `input.cancel` → abort wiring |
| `src/scripts/check-architecture.ts` | Remove `controlplane/methods.ts` from A5 whitelist |
| `src/application/ports/tool-catalog.ts` | Replace stub with real `ToolCatalog` interface |
| `src/application/ports/tool-context.ts` | Remove `Tool`/`ToolImplementation` types (move to `ports/tool.ts`) |
| `src/application/usecases/run-turn.ts` | Add `ToolContext` construction (signal + cwd); pass through to onToolCall |
| `src/domain/turn-runner.ts` | Add `signal.aborted` check between iterations |
| `src/domain/turn-runner.types.ts` | Update `RunTurnHooks.onToolCall` ctx type |
| `src/extensions/session/index.ts` | Add `AbortController` map + `session.abort` capability |
| `src/extensions/tools/index.ts` | 300→~60 lines: 9 `defineTool` + `catalog.register`; delete `onToolCall`/`resolveTools` hooks |
| `src/extensions/mcp/index.ts` | Use `ToolCatalog` instead of `ToolRegistry`; dynamic register/unregister |
| `src/types.ts` | Delete `Tool`/`ToolImplementation`/`ToolContext` re-exports |

### Deleted files (5)

| File | Reason |
|------|--------|
| `src/extensions/tools/tools/zod-tool.ts` (232 lines) | Replaced by `defineTool` factory |
| `src/extensions/tools/tools/bash.ts` | Migrated to `extensions/tools/bash.ts` |
| `src/extensions/tools/tools/read.ts` | Migrated to `extensions/tools/read.ts` |
| `src/extensions/tools/tools/grep.ts` | Migrated to `extensions/tools/grep.ts` |
| `src/extensions/tools/tools/glob.ts` | Migrated to `extensions/tools/glob.ts` |
| `src/extensions/tools/tools/ls.ts` | Migrated to `extensions/tools/ls.ts` |
| `src/extensions/tools/tools/text-editor.ts` | Migrated to `extensions/tools/text-editor.ts` |
| `src/extensions/tools/tools/web-search.ts` | Migrated to `extensions/tools/web-search.ts` |
| `src/extensions/tools/tools/web-fetch.ts` | Migrated to `extensions/tools/web-fetch.ts` |
| `src/extensions/tools/tools/ask-user-question.ts` | Migrated to `extensions/tools/ask-user-question.ts` |
| `src/extensions/mcp/mcp/tool-registry.ts` | Replaced by central `ToolCatalog` |
| `src/extensions/memory/memory/tool.ts` | Dead code (zero consumers) |
| `src/extensions/evolution/evolution/review-tools.ts` | Dead code (zero consumers) |

---

## Track A: ControlPlane Event Contractualization (Tasks 1–5)

### Task 1: Add system-events contract file

**Files:**
- Create: `src/application/contracts/system-events.ts`

- [ ] **Step 1: Create system-events.ts with all 8 new event contracts**

```ts
// System-level event contracts for controlplane-emitted events.
// Event names: attach.changed, session.resumed, session.closed, session.renamed,
//   user.question.answered, system.shutdown.requested, input.cancelled, turn.cancelled

export interface AttachChangedV1 {
  frontendId: string;
  sessionId: string;
  action: 'attached' | 'detached';
}

export interface SessionResumedV1 {
  sessionId: string;
  frontendId?: string;
  previousSessionId: string | null;
}

export interface SessionClosedV1 {
  sessionId: string;
  force: boolean;
}

export interface SessionRenamedV1 {
  sessionId: string;
  title: string;
}

export interface UserQuestionAnsweredV1 {
  sessionId: string;
  questionId: string;
  answers: Array<{ question_index: number; selected_labels: string[] }>;
}

export interface SystemShutdownRequestedV1 {
  profileId: string;
  timestamp: string;
}

export interface InputCancelledV1 {
  sessionId: string;
  reason: string;
}

export interface TurnCancelledV1 {
  sessionId: string;
  reason: string;
}
```

- [ ] **Step 2: Verify file compiles**

Run: `bun run tsc --noEmit 2>&1 | head -5`
Expected: no errors from this file.

- [ ] **Step 3: Commit**

```bash
git add src/application/contracts/system-events.ts
git commit -m "feat(p7): add system-events contract with 8 new event types"
```

---

### Task 2: Extend session-events.ts — fix SessionCreatedV1

**Files:**
- Modify: `src/application/contracts/session-events.ts`

The current `SessionCreatedV1` only has `{ id, title }`. The controlplane `session.create` RPC emits the full `Session` domain object via raw `ctx.bus.emit('session.created', session)`. We already have a contract emit in the session extension that uses `SessionCreatedV1` correctly. The controlplane one is the raw one — it needs to match the contract. Add `profileId` and `isMain` to make the contract complete.

- [ ] **Step 1: Read current session-events.ts to confirm content**

Expected: `SessionCreatedV1` has `{ id, title }`.

- [ ] **Step 2: Extend SessionCreatedV1**

```ts
export interface SessionCreatedV1 {
  id: string;
  title: string;
  profileId?: string;
  isMain?: boolean;
}
```

And update the codec:
```ts
export const sessionCreatedCodec = createCodec<SessionCreatedV1>(
  z.object({
    id: z.string(),
    title: z.string(),
    profileId: z.string().optional(),
    isMain: z.boolean().optional(),
  }),
);
```

- [ ] **Step 3: Verify compilation**

Run: `bun run tsc --noEmit 2>&1 | head -5`

- [ ] **Step 4: Commit**

```bash
git add src/application/contracts/session-events.ts
git commit -m "feat(p7): extend SessionCreatedV1 with profileId and isMain fields"
```

---

### Task 3: Extend ContractedEventMap with 8 new mappings

**Files:**
- Modify: `src/application/contracts/events/contracted-event-map.ts`

- [ ] **Step 1: Add imports for new event types**

```ts
import type {
  AttachChangedV1,
  SessionResumedV1,
  SessionClosedV1,
  SessionRenamedV1,
  UserQuestionAnsweredV1,
  SystemShutdownRequestedV1,
  InputCancelledV1,
  TurnCancelledV1,
} from '../system-events';
```

Add these after the existing imports.

- [ ] **Step 2: Add 8 new entries to ContractedEventMap**

```ts
export interface ContractedEventMap {
  // ... existing 14 entries remain ...

  // P-7: system events from controlplane
  'attach.changed': AttachChangedV1
  'session.resumed': SessionResumedV1
  'session.closed': SessionClosedV1
  'session.renamed': SessionRenamedV1
  'user.question.answered': UserQuestionAnsweredV1
  'system.shutdown.requested': SystemShutdownRequestedV1
  'input.cancelled': InputCancelledV1
  'turn.cancelled': TurnCancelledV1
}
```

- [ ] **Step 3: Verify compilation**

Run: `bun run tsc --noEmit 2>&1 | head -5`

- [ ] **Step 4: Commit**

```bash
git add src/application/contracts/events/contracted-event-map.ts
git commit -m "feat(p7): add 8 system event mappings to ContractedEventMap (14→22)"
```

---

### Task 4: Migrate controlplane methods.ts — 12 raw emit → contractBus

**Files:**
- Modify: `src/extensions/controlplane/methods.ts`

Replace all 12 `ctx.bus.emit('event', {...})` calls with `contractBus.emit(createEvent('event', {...}))`.

- [ ] **Step 1: Add imports**

Add after existing imports at top of file:
```ts
import { createEvent } from '../../application/contracts'
import { asContractBus } from '../../application/event-bus/contract-bus'
```

- [ ] **Step 2: Create contractBus in apply()**

Add after the `getServer` line (line 24):
```ts
const contractBus = asContractBus(ctx.bus)
```

- [ ] **Step 3: Replace all 12 raw emits**

Replace each `ctx.bus.emit(...)` call:

Line 61: `ctx.bus.emit('attach.changed', { frontendId, sessionId, action: 'attached' })` →
```ts
contractBus.emit(createEvent('attach.changed', { frontendId, sessionId, action: 'attached' }))
```

Line 82: `ctx.bus.emit('attach.changed', { frontendId, sessionId, action: 'detached' })` →
```ts
contractBus.emit(createEvent('attach.changed', { frontendId, sessionId, action: 'detached' }))
```

Line 102: `ctx.bus.emit('attach.changed', { frontendId, sessionId: currentId, action: 'detached' })` →
```ts
contractBus.emit(createEvent('attach.changed', { frontendId, sessionId: currentId, action: 'detached' }))
```

Line 110: `ctx.bus.emit('attach.changed', { frontendId, sessionId: targetId, action: 'attached' })` →
```ts
contractBus.emit(createEvent('attach.changed', { frontendId, sessionId: targetId, action: 'attached' }))
```

Line 113: `ctx.bus.emit('session.resumed', { sessionId: targetId, frontendId, previousSessionId: currentId ?? null })` →
```ts
contractBus.emit(createEvent('session.resumed', { sessionId: targetId, frontendId, previousSessionId: currentId ?? null }))
```

Line 124: `ctx.bus.emit('session.created', session)` — this emits the raw Session domain object, violating the SessionCreatedV1 contract →
```ts
contractBus.emit(createEvent('session.created', {
  id: session.id,
  title: session.title ?? session.id,
  profileId: session.profileId,
  isMain: session.isMain,
}))
```

Line 136: `ctx.bus.emit('session.closed', { sessionId, force: p?.force ?? false })` →
```ts
contractBus.emit(createEvent('session.closed', { sessionId, force: p?.force ?? false }))
```

Line 149: `ctx.bus.emit('session.renamed', { sessionId, title: p.title })` →
```ts
contractBus.emit(createEvent('session.renamed', { sessionId, title: p.title }))
```

Line 191: `ctx.bus.emit('input.cancelled', { sessionId, reason: p?.reason ?? 'user requested' })` →
```ts
contractBus.emit(createEvent('input.cancelled', { sessionId, reason: p?.reason ?? 'user requested' }))
```

Line 196: `ctx.bus.emit('turn.cancelled', { sessionId, reason: p?.reason ?? 'user requested' })` →
```ts
contractBus.emit(createEvent('turn.cancelled', { sessionId, reason: p?.reason ?? 'user requested' }))
```

Line 206: `ctx.bus.emit('user.question.answered', { sessionId: p?.sessionId ?? 'main', questionId: p.questionId, answers: p?.answers ?? [] })` →
```ts
contractBus.emit(createEvent('user.question.answered', { sessionId: p?.sessionId ?? 'main', questionId: p.questionId, answers: p?.answers ?? [] }))
```

Line 223: `await ctx.bus.emit('system.shutdown.requested', { profileId: ctx.profileId, timestamp: new Date().toISOString() })` →
```ts
await contractBus.emit(createEvent('system.shutdown.requested', { profileId: ctx.profileId, timestamp: new Date().toISOString() }))
```

- [ ] **Step 4: Verify — grep for remaining raw emits**

Run: `grep -n 'ctx\.bus\.emit(' src/extensions/controlplane/methods.ts`
Expected: 0 results.

- [ ] **Step 5: Verify compilation**

Run: `bun run tsc --noEmit 2>&1 | head -10`

- [ ] **Step 6: Run architecture check**

Run: `bun run check:arch 2>&1 | tail -20`
Expected: A5 violations still show for controlplane/methods.ts (whitelist not yet removed).

- [ ] **Step 7: Commit**

```bash
git add src/extensions/controlplane/methods.ts
git commit -m "refactor(p7): migrate controlplane methods to contractBus (12 emits)"
```

---

### Task 5: Remove controlplane from A5 whitelist

**Files:**
- Modify: `scripts/check-architecture.ts`

- [ ] **Step 1: Update A5 whitelist**

Line 208: Change
```ts
const A5_WHITELIST_FILES = new Set(['controlplane/methods.ts', 'dataplane/index.ts']);
```
to
```ts
const A5_WHITELIST_FILES = new Set(['dataplane/index.ts']);
```

- [ ] **Step 2: Update A5 CONTRACTED_EVENT_NAMES set to include 8 new events**

```ts
const CONTRACTED_EVENT_NAMES = new Set([
  'provider.selected', 'llm.delta',
  'memory.summary.ready', 'memory.summarized',
  'evolution.proposal.accepted', 'evolution.proposal.rejected',
  'skills.reloaded',
  'session.created', 'turn.started', 'turn.completed', 'turn.failed',
  'tool.executed',
  'permission.required',
  'identity.changed',
  // P-7: system events
  'attach.changed', 'session.resumed', 'session.closed', 'session.renamed',
  'user.question.answered', 'system.shutdown.requested',
  'input.cancelled', 'turn.cancelled',
]);
```

- [ ] **Step 3: Run architecture check — verify clean**

Run: `bun run check:arch 2>&1 | tail -10`
Expected: no A5 violations. If controlplane/methods.ts still shows violations, check that all 12 emits were converted.

- [ ] **Step 4: Verify: intentionally add a raw emit to test guard**

Temporarily add `ctx.bus.emit('session.created', {})` to controlplane/methods.ts, run `bun run check:arch`, confirm `[A5]` violation. Revert.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-architecture.ts
git commit -m "chore(p7): remove controlplane from A5 whitelist — 0 exemption files remain"
```

---

## Track B: Tool Abstraction Refactor (Tasks 6–19)

### Task 6: Create unified Tool interface in ports/tool.ts

**Files:**
- Create: `src/application/ports/tool.ts`

- [ ] **Step 1: Create ports/tool.ts with unified Tool interface**

```ts
// Unified Tool type — the single tool representation.
// Merges the former Tool (definition-only) and ToolImplementation (definition + execute).
// ToolContext is defined separately in ports/tool-context.ts.

import type { ToolContext } from './tool-context';

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  parse?: (raw: Record<string, unknown>) => Record<string, unknown>;
  execute: (ctx: ToolContext, params: Record<string, unknown>) => Promise<unknown>;
  readonly?: boolean;
  conflictKey?: (input: unknown) => string | null;
}
```

- [ ] **Step 2: Create ToolExecutor port**

Create: `src/application/ports/tool-executor.ts`
```ts
import type { Tool } from './tool';

export interface ToolExecutor {
  execute(tool: Tool, input: Record<string, unknown>, ctx: import('./tool-context').ToolContext): Promise<unknown>;
}
```

- [ ] **Step 3: Update tool-catalog.ts — replace stub with real interface**

Replace `src/application/ports/tool-catalog.ts`:
```ts
import type { Tool } from './tool';

export interface ToolCatalog {
  register(tool: Tool): void;
  unregister(name: string): void;
  list(): Tool[];
  get(name: string): Tool | undefined;
}
```

- [ ] **Step 4: Clean up tool-context.ts — remove Tool/ToolImplementation**

`src/application/ports/tool-context.ts` should become:
```ts
// Port for tool execution context — zero IO imports.

export interface ToolContext {
  signal: AbortSignal;
  environment: { cwd: string };
}
```

Remove the `Tool` type and `ToolImplementation` interface from this file.

- [ ] **Step 5: Verify compilation** (expect errors from files still importing old types)

Run: `bun run tsc --noEmit 2>&1 | head -20`
Expected: errors about missing `Tool`/`ToolImplementation` exports from `tool-context.ts` and `types.ts`. This is expected — they'll be fixed in subsequent tasks.

- [ ] **Step 6: Commit**

```bash
git add src/application/ports/tool.ts src/application/ports/tool-executor.ts src/application/ports/tool-catalog.ts src/application/ports/tool-context.ts
git commit -m "refactor(p7): introduce unified Tool interface, ToolExecutor port, real ToolCatalog"
```

---

### Task 7: Create defineTool factory

**Files:**
- Create: `src/application/tool-factory/define-tool.ts`

- [ ] **Step 1: Create define-tool.ts**

```ts
import type { Tool } from '../ports/tool';
import type { ToolContext } from '../ports/tool-context';

export function defineTool(config: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  parse?: (raw: Record<string, unknown>) => Record<string, unknown>;
  execute: (ctx: ToolContext, params: Record<string, unknown>) => Promise<unknown>;
  readonly?: boolean;
  conflictKey?: (input: unknown) => string | null;
}): Tool {
  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    parse: config.parse,
    execute: config.execute,
    readonly: config.readonly,
    conflictKey: config.conflictKey,
  };
}
```

- [ ] **Step 2: Verify compilation**

Run: `bun run tsc --noEmit 2>&1 | grep define-tool`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/application/tool-factory/define-tool.ts
git commit -m "feat(p7): add defineTool factory function"
```

---

### Task 8: Create dispatch-tool usecase

**Files:**
- Create: `src/application/usecases/dispatch-tool.ts`

- [ ] **Step 1: Create dispatch-tool.ts**

```ts
import type { ToolCatalog } from '../ports/tool-catalog';
import type { ToolExecutor } from '../ports/tool-executor';
import type { ToolContext } from '../ports/tool-context';

export async function dispatchTool(
  catalog: ToolCatalog,
  executor: ToolExecutor,
  call: { name: string; arguments: Record<string, unknown> },
  ctx: ToolContext,
): Promise<unknown> {
  const tool = catalog.get(call.name);
  if (!tool) {
    return { content: `Tool not found: ${call.name}`, isError: true };
  }

  const input = tool.parse ? tool.parse(call.arguments) : call.arguments;
  return executor.execute(tool, input, ctx);
}
```

- [ ] **Step 2: Verify compilation**

Run: `bun run tsc --noEmit 2>&1 | grep dispatch-tool`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/application/usecases/dispatch-tool.ts
git commit -m "feat(p7): add dispatch-tool usecase"
```

---

### Task 9: Create InMemoryCatalog + InProcessExecutor

**Files:**
- Create: `src/application/tool-catalog/in-memory-catalog.ts`
- Create: `src/infrastructure/tool/in-process-executor.ts`

- [ ] **Step 1: Create InMemoryCatalog**

```ts
import type { ToolCatalog } from '../ports/tool-catalog';
import type { Tool } from '../ports/tool';

export class InMemoryCatalog implements ToolCatalog {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }
}
```

- [ ] **Step 2: Create InProcessExecutor**

```ts
import type { ToolExecutor } from '../../application/ports/tool-executor';
import type { Tool } from '../../application/ports/tool';
import type { ToolContext } from '../../application/ports/tool-context';

export class InProcessExecutor implements ToolExecutor {
  async execute(tool: Tool, input: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    return tool.execute(ctx, input);
  }
}
```

- [ ] **Step 3: Verify compilation**

Run: `bun run tsc --noEmit 2>&1 | grep -E '(in-memory-catalog|in-process-executor)'`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/application/tool-catalog/in-memory-catalog.ts src/infrastructure/tool/in-process-executor.ts
git commit -m "feat(p7): add InMemoryCatalog and InProcessExecutor"
```

---

### Task 10: Create tool-catalog extension (enforce: pre)

**Files:**
- Create: `src/extensions/tool-catalog/index.ts`

- [ ] **Step 1: Create tool-catalog extension**

```ts
import { defineExtension } from '../../kernel/define-extension';
import type { HookHandler } from '../../kernel/define-extension';
import { InMemoryCatalog } from '../../application/tool-catalog/in-memory-catalog';
import { InProcessExecutor } from '../../infrastructure/tool/in-process-executor';
import { dispatchTool } from '../../application/usecases/dispatch-tool';
import type { ToolCatalog } from '../../application/ports/tool-catalog';
import type { ToolExecutor } from '../../application/ports/tool-executor';
import type { ToolContext } from '../../application/ports/tool-context';
import { createEvent } from '../../application/contracts';
import { asContractBus } from '../../application/event-bus/contract-bus';

export default () =>
  defineExtension({
    name: 'tool-catalog',
    enforce: 'pre',

    apply: (ctx) => {
      const catalog: ToolCatalog = new InMemoryCatalog();
      const executor: ToolExecutor = new InProcessExecutor();
      const contractBus = asContractBus(ctx.bus);

      const onToolCall: HookHandler = async (...args: unknown[]) => {
        const call = args[0] as { name: string; arguments: Record<string, unknown>; id: string };
        const toolCtx = args[1] as ToolContext;

        const startTime = Date.now();
        const result = await dispatchTool(catalog, executor, call, toolCtx);
        const duration = Date.now() - startTime;

        const isError = typeof result === 'object' && result !== null && 'isError' in result
          ? (result as { isError?: boolean }).isError === true
          : false;

        await contractBus.emit(createEvent('tool.executed', {
          name: call.name,
          duration,
          isError,
        }));

        return result;
      };

      return {
        provide: {
          catalog: () => catalog,
        },
        hooks: {
          onToolCall: {
            enforce: 'normal',
            fn: onToolCall,
          },
        },
        dispose: () => {},
      };
    },
  });
```

- [ ] **Step 2: Verify compilation**

Run: `bun run tsc --noEmit 2>&1 | grep tool-catalog`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/extensions/tool-catalog/index.ts
git commit -m "feat(p7): add tool-catalog extension (enforce: pre) with onToolCall hook"
```

---

### Task 11: Create parse-with-zod helper

**Files:**
- Create: `src/extensions/tools/parse-with-zod.ts`

- [ ] **Step 1: Create parse-with-zod.ts (~25 lines)**

Covering only the Zod types used by the 9 builtin tools: ZodString, ZodNumber, ZodBoolean, ZodEnum, ZodObject, ZodArray, ZodOptional, ZodDefault, ZodNullable.

```ts
import { z } from 'zod';

export function parseWithZod<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
): (raw: Record<string, unknown>) => Record<string, unknown> {
  return (raw: Record<string, unknown>) => {
    const result = schema.safeParse(raw);
    if (!result.success) {
      const errors = result.error.issues
        .map((issue) => `- ${issue.path.join('.')}: ${issue.message}`)
        .join('\n');
      throw new Error(`Parameter validation failed:\n${errors}`);
    }
    return result.data as Record<string, unknown>;
  };
}

export function zodToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(schema.shape)) {
    const zodSchema = value as z.ZodTypeAny;
    properties[key] = zodFieldToJson(zodSchema);

    let current: z.ZodTypeAny = zodSchema;
    let isOptional = false;
    while (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault
    ) {
      if (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
        isOptional = true;
      }
      current = current._def.innerType;
    }
    if (!isOptional) {
      required.push(key);
    }
  }

  const result: Record<string, unknown> = { type: 'object', properties };
  if (required.length > 0) result.required = required;
  return result;
}

function zodFieldToJson(schema: z.ZodTypeAny): Record<string, unknown> {
  // Unwrap optional/nullable/default layers
  let inner = schema;
  while (
    inner instanceof z.ZodOptional ||
    inner instanceof z.ZodNullable ||
    inner instanceof z.ZodDefault
  ) {
    inner = inner._def.innerType;
  }

  if (inner instanceof z.ZodString) return { type: 'string', ...(inner.description ? { description: inner.description } : {}) };
  if (inner instanceof z.ZodNumber) return { type: 'number', ...(inner.description ? { description: inner.description } : {}) };
  if (inner instanceof z.ZodBoolean) return { type: 'boolean', ...(inner.description ? { description: inner.description } : {}) };
  if (inner instanceof z.ZodEnum) return { type: 'string', enum: inner.options, ...(inner.description ? { description: inner.description } : {}) };
  if (inner instanceof z.ZodArray) {
    return { type: 'array', items: zodFieldToJson(inner.element), ...(inner.description ? { description: inner.description } : {}) };
  }
  if (inner instanceof z.ZodObject) {
    return zodToJsonSchema(inner as z.ZodObject<z.ZodRawShape>);
  }
  // Fallback
  return { type: 'string' };
}
```

- [ ] **Step 2: Verify compilation**

Run: `bun run tsc --noEmit 2>&1 | grep parse-with-zod`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/extensions/tools/parse-with-zod.ts
git commit -m "feat(p7): add parse-with-zod and zodToJsonSchema helpers"
```

---

### Task 12: Migrate bash.ts — first tool to new pattern

**Files:**
- Create: `src/extensions/tools/bash.ts`
- Delete: `src/extensions/tools/tools/bash.ts`

This is the most complex tool — it handles abort signals, timeouts, working directories. Migrate to export `schema` + `execute` function.

- [ ] **Step 1: Create new bash.ts**

```ts
import { exec } from 'child_process';
import path from 'path';
import { z } from 'zod';
import type { ToolContext } from '../../application/ports/tool-context';

const BYTES_PER_KB = 1024;
const MB = BYTES_PER_KB * BYTES_PER_KB;
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const MAX_BUFFER_MULTIPLIER = 10;
const DEFAULT_MAX_OUTPUT_BYTES = MB;
const CHILD_PROCESS_MAX_BUFFER = MAX_BUFFER_MULTIPLIER * MB;
const SIGTERM_EXIT_CODE = 130;
const TIMEOUT_EXIT_CODE = 124;

export const bashSchema = z.object({
  command: z.string().describe('The shell command to execute.'),
  cwd: z.string().optional().describe('Working directory for the command (optional).'),
});

export type BashToolOptions = {
  timeoutMs?: number;
  maxOutputBytes?: number;
  allowedWorkingDirs?: string[];
};

export function createBashExecute(options: BashToolOptions = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const allowedWorkingDirs = options.allowedWorkingDirs ?? [];

  return async function bashExecute(
    args: z.infer<typeof bashSchema>,
    ctx: ToolContext,
  ): Promise<{
    output: string;
    exitCode: number | null;
    timedOut: boolean;
    truncated: boolean;
  }> {
    const cwd = path.resolve(args.cwd ?? ctx.environment.cwd);
    if (allowedWorkingDirs.length > 0) {
      const isAllowed = allowedWorkingDirs.some((allowed) => {
        const resolvedAllowed = path.resolve(allowed);
        return cwd === resolvedAllowed || cwd.startsWith(resolvedAllowed + path.sep);
      });
      if (!isAllowed) {
        return { output: `Error: Working directory "${cwd}" is not allowed.`, exitCode: 1, timedOut: false, truncated: false };
      }
    }

    return new Promise((resolve) => {
      let output = '';
      let outputBytes = 0;
      let truncated = false;

      const proc = exec(args.command, { cwd, maxBuffer: CHILD_PROCESS_MAX_BUFFER, timeout: timeoutMs });
      let resolved = false;

      proc.stdout?.on('data', (data) => {
        const bytes = Buffer.byteLength(data);
        if (outputBytes + bytes > maxOutputBytes) {
          truncated = true;
          const remaining = maxOutputBytes - outputBytes;
          output += data.toString().slice(0, remaining);
          outputBytes = maxOutputBytes;
        } else {
          output += data.toString();
          outputBytes += bytes;
        }
      });

      proc.stderr?.on('data', (data) => {
        const bytes = Buffer.byteLength(data);
        if (outputBytes + bytes > maxOutputBytes) {
          truncated = true;
          const remaining = maxOutputBytes - outputBytes;
          output += data.toString().slice(0, remaining);
          outputBytes = maxOutputBytes;
        } else {
          output += data.toString();
          outputBytes += bytes;
        }
      });

      proc.on('error', (error) => {
        output += `Error: ${error.message}`;
        resolve({ output, exitCode: 1, timedOut: false, truncated });
      });

      if (ctx.signal) {
        const handleAbort = () => {
          if (resolved) return;
          cleanup();
          if (proc?.pid) {
            try { process.kill(-proc.pid); } catch {
              try { proc.kill(); } catch { /* already exited */ }
            }
          }
          output += `\n--- Command aborted by user ---`;
          resolved = true;
          resolve({ output, exitCode: SIGTERM_EXIT_CODE, timedOut: false, truncated });
        };

        const cleanup = () => ctx.signal.removeEventListener('abort', handleAbort);
        ctx.signal.addEventListener('abort', handleAbort);
        proc.on('exit', cleanup);
        proc.on('timeout', cleanup);
        proc.on('error', cleanup);

        if (ctx.signal.aborted) handleAbort();
      }

      proc.on('timeout', () => {
        proc.kill();
        output += `\n--- Command timed out after ${timeoutMs}ms ---`;
        resolved = true;
        resolve({ output, exitCode: TIMEOUT_EXIT_CODE, timedOut: true, truncated });
      });

      proc.on('exit', (code, signal) => {
        if (resolved) return;
        if (signal) output += `\n--- Killed by signal ${signal} ---`;
        const timedOut = timeoutMs > 0 && signal === 'SIGTERM';
        resolve({ output, exitCode: timedOut ? TIMEOUT_EXIT_CODE : code, timedOut, truncated });
      });
    });
  };
}
```

- [ ] **Step 2: Delete old file**

```bash
rm src/extensions/tools/tools/bash.ts
```

- [ ] **Step 3: Verify compilation** (expect errors from ZodTool still referenced by other files)

Run: `bun run tsc --noEmit 2>&1 | grep bash`
Expected: no errors for the new bash.ts.

- [ ] **Step 4: Commit**

```bash
git add src/extensions/tools/bash.ts && git rm src/extensions/tools/tools/bash.ts
git commit -m "refactor(p7): migrate bash tool from ZodTool class to createBashExecute function"
```

---

### Task 13: Migrate remaining 8 tools

**Files:** Migrate each tool from `tools/tools/<name>.ts` → `tools/<name>.ts`.

For each of the 8 remaining tools, apply the same pattern: export a Zod schema + an execute function (or factory that returns execute). Delete the old ZodTool subclass file.

- [ ] **Step 1: read.ts**

Create `src/extensions/tools/read.ts`:
```ts
import { z } from 'zod';
import { readFile } from 'fs/promises';
import path from 'path';
import type { ToolContext } from '../../application/ports/tool-context';

export const readSchema = z.object({
  filePath: z.string().describe('Path to the file to read'),
  offset: z.number().optional().describe('Line number to start reading from (1-indexed)'),
  limit: z.number().optional().describe('Maximum number of lines to read'),
});

export async function readExecute(
  args: z.infer<typeof readSchema>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  try {
    const filePath = path.resolve(ctx.environment.cwd, args.filePath);
    let content = await readFile(filePath, 'utf-8');
    if (args.offset !== undefined || args.limit !== undefined) {
      const lines = content.split('\n');
      const start = Math.max(0, (args.offset ?? 1) - 1);
      const end = args.limit ? Math.min(lines.length, start + args.limit) : lines.length;
      content = lines.slice(start, end).join('\n');
    }
    return { content };
  } catch (err: any) {
    return { content: `Error reading file: ${err.message}`, isError: true };
  }
}
```

- [ ] **Step 2: text-editor.ts**

Create `src/extensions/tools/text-editor.ts`:
```ts
import { z } from 'zod';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import type { ToolContext } from '../../application/ports/tool-context';

export const textEditorSchema = z.object({
  filePath: z.string().describe('Path to the file to edit'),
  oldString: z.string().describe('The exact string to replace'),
  newString: z.string().describe('The new string to replace it with'),
});

export async function textEditorExecute(
  args: z.infer<typeof textEditorSchema>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  try {
    const filePath = path.resolve(ctx.environment.cwd, args.filePath);
    let content = await readFile(filePath, 'utf-8');
    const escaped = args.oldString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const count = (content.match(new RegExp(escaped, 'g')) || []).length;
    if (count === 0) return { content: 'Error: old_string not found in file', isError: true };
    if (count > 1) return { content: `Error: old_string appears ${count} times, must be unique`, isError: true };
    content = content.replace(args.oldString, args.newString);
    await writeFile(filePath, content, 'utf-8');
    return { content: `Successfully edited ${filePath}` };
  } catch (err: any) {
    return { content: `Error: ${err.message}`, isError: true };
  }
}
```

- [ ] **Step 3: grep.ts**

Create `src/extensions/tools/grep.ts`:
```ts
import { z } from 'zod';
import { exec } from 'child_process';
import type { ToolContext } from '../../application/ports/tool-context';

export const grepSchema = z.object({
  pattern: z.string().describe('Regular expression pattern to search for'),
  path: z.string().default(process.cwd()).describe('Directory or file to search in (default: .)'),
  glob: z.string().optional().describe('Glob pattern to filter files'),
});

export function grepExecute(
  args: z.infer<typeof grepSchema>,
  _ctx: ToolContext,
): Promise<{ content: string }> {
  const globArg = args.glob ? `--glob '${args.glob}'` : '';
  const cmd = `rg -n ${globArg} '${args.pattern}' '${args.path}' 2>/dev/null || grep -rn '${args.pattern}' '${args.path}' 2>/dev/null || echo 'No matches found.'`;
  return new Promise((resolve) => {
    exec(cmd, { cwd: process.cwd() }, (_error, stdout) => {
      resolve({ content: stdout.trim() || 'No matches found.' });
    });
  });
}
```

- [ ] **Step 4: glob.ts**

Create `src/extensions/tools/glob.ts`:
```ts
import { z } from 'zod';
import { readdir } from 'fs/promises';
import path from 'path';
import type { ToolContext } from '../../application/ports/tool-context';

export const globSchema = z.object({
  pattern: z.string().describe('Glob pattern (e.g. **/*.ts)'),
  path: z.string().default(process.cwd()).describe('Base directory (default: .)'),
});

export async function globExecute(
  args: z.infer<typeof globSchema>,
  ctx: ToolContext,
): Promise<{ content: string }> {
  const basePath = path.resolve(ctx.environment.cwd, args.path);
  const results: string[] = [];

  async function walk(d: string): Promise<void> {
    try {
      const entries = await readdir(d, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
          await walk(full);
        } else if (e.isFile()) {
          const rel = path.relative(basePath, full);
          if (matchSimple(rel, args.pattern)) results.push(rel);
        }
      }
    } catch {}
  }

  function matchSimple(file: string, pat: string): boolean {
    if (pat === '**/*') return true;
    if (pat.startsWith('**/*.')) return file.endsWith(pat.slice(4));
    return file.includes(pat.replace(/\*/g, ''));
  }

  await walk(basePath);
  return { content: results.slice(0, 500).join('\n') || 'No matching files found.' };
}
```

- [ ] **Step 5: ls.ts**

Create `src/extensions/tools/ls.ts`:
```ts
import { z } from 'zod';
import { readdir } from 'fs/promises';
import path from 'path';
import type { ToolContext } from '../../application/ports/tool-context';

export const lsSchema = z.object({
  path: z.string().default(process.cwd()).describe('Directory path to list (default: .)'),
  a: z.boolean().optional().describe('Show hidden files'),
});

export async function lsExecute(
  args: z.infer<typeof lsSchema>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  try {
    const dirPath = path.resolve(ctx.environment.cwd, args.path);
    const files = await readdir(dirPath);
    const filtered = args.a ? files : files.filter((f) => !f.startsWith('.'));
    return { content: filtered.join('\n') || '(empty directory)' };
  } catch (err: any) {
    return { content: `Error: ${err.message}`, isError: true };
  }
}
```

- [ ] **Step 6: web-search.ts**

Create `src/extensions/tools/web-search.ts`:
```ts
import { z } from 'zod';
import type { ToolContext } from '../../application/ports/tool-context';

export const webSearchSchema = z.object({
  query: z.string().describe('Search query'),
});

export async function webSearchExecute(
  args: z.infer<typeof webSearchSchema>,
  _ctx: ToolContext,
): Promise<unknown> {
  // Stub — full web search implementation deferred to later spec
  return { content: `Web search not yet available. Query: ${args.query}`, isError: true };
}
```

- [ ] **Step 7: web-fetch.ts**

Create `src/extensions/tools/web-fetch.ts`:
```ts
import { z } from 'zod';
import type { ToolContext } from '../../application/ports/tool-context';

export const webFetchSchema = z.object({
  url: z.string().describe('URL to fetch'),
  prompt: z.string().optional().describe('Optional prompt to process fetched content'),
});

export async function webFetchExecute(
  args: z.infer<typeof webFetchSchema>,
  _ctx: ToolContext,
): Promise<unknown> {
  return { content: `Web fetch not yet implemented. URL: ${args.url}`, isError: true };
}
```

- [ ] **Step 8: ask-user-question.ts**

Create `src/extensions/tools/ask-user-question.ts`:
```ts
import { z } from 'zod';
import type { ToolContext } from '../../application/ports/tool-context';

export const askUserQuestionSchema = z.object({
  questions: z.array(z.object({
    question: z.string(),
    header: z.string(),
    options: z.array(z.object({ label: z.string(), description: z.string() })),
    multiSelect: z.boolean().optional(),
  })),
});

export async function askUserQuestionExecute(
  args: z.infer<typeof askUserQuestionSchema>,
  _ctx: ToolContext,
): Promise<unknown> {
  return { content: `User question not yet implemented. Questions: ${args.questions.length}`, isError: true };
}
```

- [ ] **Step 9: Delete old ZodTool subclass files**

```bash
rm src/extensions/tools/tools/read.ts
rm src/extensions/tools/tools/text-editor.ts
rm src/extensions/tools/tools/grep.ts
rm src/extensions/tools/tools/glob.ts
rm src/extensions/tools/tools/ls.ts
rm src/extensions/tools/tools/web-search.ts
rm src/extensions/tools/tools/web-fetch.ts
rm src/extensions/tools/tools/ask-user-question.ts
```

- [ ] **Step 10: Verify compilation**

Run: `bun run tsc --noEmit 2>&1 | head -20`
Expected: errors only from files still importing deleted ZodTool (MemoryTool, CreateReviewSkillTool, tools/index.ts, mcp/*). These will be fixed in subsequent tasks.

- [ ] **Step 11: Commit**

```bash
git add src/extensions/tools/read.ts src/extensions/tools/text-editor.ts src/extensions/tools/grep.ts src/extensions/tools/glob.ts src/extensions/tools/ls.ts src/extensions/tools/web-search.ts src/extensions/tools/web-fetch.ts src/extensions/tools/ask-user-question.ts
git rm src/extensions/tools/tools/read.ts src/extensions/tools/tools/text-editor.ts src/extensions/tools/tools/grep.ts src/extensions/tools/tools/glob.ts src/extensions/tools/tools/ls.ts src/extensions/tools/tools/web-search.ts src/extensions/tools/tools/web-fetch.ts src/extensions/tools/tools/ask-user-question.ts
git commit -m "refactor(p7): migrate 8 tools from ZodTool classes to schema+execute functions"
```

---

### Task 14: Rewrite tools extension index.ts (300→~60 lines)

**Files:**
- Modify: `src/extensions/tools/index.ts`

Remove all inline tool definitions (the 6 `registerTool()` calls), `toolSchemas`, `resolveTools` hook, and `onToolCall` hook. Replace with 9 `defineTool()` + `catalog.register()` calls. The `resolveTools` hook stays but simplified — it queries the catalog.

- [ ] **Step 1: Rewrite tools/index.ts**

```ts
import { defineExtension } from '../../kernel/define-extension';
import type { HookHandler } from '../../kernel/define-extension';
import { defineTool } from '../../application/tool-factory/define-tool';
import type { ToolCatalog } from '../../application/ports/tool-catalog';
import { parseWithZod, zodToJsonSchema } from './parse-with-zod';
import { bashSchema, createBashExecute } from './bash';
import { readSchema, readExecute } from './read';
import { textEditorSchema, textEditorExecute } from './text-editor';
import { grepSchema, grepExecute } from './grep';
import { globSchema, globExecute } from './glob';
import { lsSchema, lsExecute } from './ls';
import { webSearchSchema, webSearchExecute } from './web-search';
import { webFetchSchema, webFetchExecute } from './web-fetch';
import { askUserQuestionSchema, askUserQuestionExecute } from './ask-user-question';

export default () =>
  defineExtension({
    name: 'tools',
    enforce: 'normal',
    dependsOn: ['tool-catalog'],

    apply: (ctx) => {
      const catalog = ctx.extensions.get<ToolCatalog>('tool-catalog.catalog');

      // Register 9 builtin tools
      catalog.register(defineTool({
        name: 'bash',
        description: 'Execute a shell command on the local system...',
        parameters: zodToJsonSchema(bashSchema),
        parse: parseWithZod(bashSchema),
        execute: async (toolCtx, params) => createBashExecute()(params as any, toolCtx),
        conflictKey: () => 'bash:global',
      }));

      catalog.register(defineTool({
        name: 'read',
        description: 'Read a file from the local filesystem. Supports line ranges for large files.',
        parameters: zodToJsonSchema(readSchema),
        parse: parseWithZod(readSchema),
        execute: async (toolCtx, params) => readExecute(params as any, toolCtx),
        readonly: true,
      }));

      catalog.register(defineTool({
        name: 'text_editor',
        description: 'Edit text files by replacing exact strings. Use read first to see file contents.',
        parameters: zodToJsonSchema(textEditorSchema),
        parse: parseWithZod(textEditorSchema),
        execute: async (toolCtx, params) => textEditorExecute(params as any, toolCtx),
      }));

      catalog.register(defineTool({
        name: 'grep',
        description: 'Search for text patterns in files using regex.',
        parameters: zodToJsonSchema(grepSchema),
        parse: parseWithZod(grepSchema),
        execute: async (toolCtx, params) => grepExecute(params as any, toolCtx),
        readonly: true,
      }));

      catalog.register(defineTool({
        name: 'glob',
        description: 'Find files matching a glob pattern.',
        parameters: zodToJsonSchema(globSchema),
        parse: parseWithZod(globSchema),
        execute: async (toolCtx, params) => globExecute(params as any, toolCtx),
        readonly: true,
      }));

      catalog.register(defineTool({
        name: 'ls',
        description: 'List the contents of a directory.',
        parameters: zodToJsonSchema(lsSchema),
        parse: parseWithZod(lsSchema),
        execute: async (toolCtx, params) => lsExecute(params as any, toolCtx),
        readonly: true,
      }));

      catalog.register(defineTool({
        name: 'web_search',
        description: 'Search the web for current information.',
        parameters: zodToJsonSchema(webSearchSchema),
        parse: parseWithZod(webSearchSchema),
        execute: async (toolCtx, params) => webSearchExecute(params as any, toolCtx),
        readonly: true,
      }));

      catalog.register(defineTool({
        name: 'web_fetch',
        description: 'Fetch and process content from a URL.',
        parameters: zodToJsonSchema(webFetchSchema),
        parse: parseWithZod(webFetchSchema),
        execute: async (toolCtx, params) => webFetchExecute(params as any, toolCtx),
        readonly: true,
      }));

      catalog.register(defineTool({
        name: 'ask_user_question',
        description: 'Ask the user a question to gather preferences or clarify requirements.',
        parameters: zodToJsonSchema(askUserQuestionSchema),
        parse: parseWithZod(askUserQuestionSchema),
        execute: async (toolCtx, params) => askUserQuestionExecute(params as any, toolCtx),
      }));

      // resolveTools: expose all catalog tools to LLM
      const resolveTools: HookHandler = async (...args: unknown[]) => {
        const existing = args[0] as Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
        const existingNames = new Set(existing.map((t) => t.name));
        const catalogTools = catalog.list()
          .filter((t) => !existingNames.has(t.name))
          .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
        return [...existing, ...catalogTools];
      };

      return {
        hooks: {
          resolveTools: {
            enforce: 'normal',
            fn: resolveTools,
          },
        },
        dispose: () => {},
      };
    },
  });
```

- [ ] **Step 2: Delete old ZodTool file**

```bash
rm src/extensions/tools/tools/zod-tool.ts
```

- [ ] **Step 3: Verify compilation**

Run: `bun run tsc --noEmit 2>&1 | head -20`
Expected: only errors from MCP ToolRegistry files, MemoryTool, CreateReviewSkillTool (not yet migrated). Tools extension should be clean.

- [ ] **Step 4: Commit**

```bash
git add src/extensions/tools/index.ts && git rm src/extensions/tools/tools/zod-tool.ts
git commit -m "refactor(p7): rewrite tools extension with defineTool + catalog, delete ZodTool class"
```

---

### Task 15: Migrate MCP tools to defineTool + catalog

**Files:**
- Modify: `src/extensions/mcp/mcp/tools.ts`
- Modify: `src/extensions/mcp/mcp/tool-adapter.ts`
- Modify: `src/extensions/mcp/mcp/prompt-registry.ts`
- Delete: `src/extensions/mcp/mcp/tool-registry.ts`
- Modify: `src/extensions/mcp/index.ts`

- [ ] **Step 1: Rewrite mcp/tools.ts — static tools to defineTool**

The 4 static MCP tools (`McpListServersTool`, `McpAddServerTool`, `McpRemoveServerTool`, `McpReadResourceTool`) become `defineTool()` calls. `McpAddServerTool` needs a catalog reference for dynamic registration. `McpRemoveServerTool` needs a catalog reference for unregistration.

```ts
import { z } from 'zod';
import { defineTool } from '../../../application/tool-factory/define-tool';
import type { Tool } from '../../../application/ports/tool';
import type { ToolCatalog } from '../../../application/ports/tool-catalog';
import type { ToolContext } from '../../../application/ports/tool-context';
import type { McpManager } from './manager';
import { McpToolAdapter, formatToolName } from './tool-adapter';
import type { McpPromptRegistry } from './prompt-registry';
import { persistServerConfig, removeServerConfig } from './server-persistence';
import type { McpServerConfig } from '../../../config/types';

const mcpServerConfigSchema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, 'Name must contain only alphanumeric chars, dashes, and underscores')
    .refine((s) => !s.includes('__'), 'Name must not contain "__" (reserved separator)'),
  transport: z.enum(['stdio', 'sse', 'streamable-http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string()).optional(),
  env: z.record(z.string()).optional(),
  autoStart: z.boolean().optional(),
}).refine((d) => d.transport !== 'stdio' || !!d.command, { message: 'command is required for stdio transport', path: ['command'] })
  .refine((d) => d.transport === 'stdio' || !!d.url, { message: 'url is required for sse/streamable-http transport', path: ['url'] })
  .refine((d) => d.transport === 'stdio' || (() => { try { new URL(d.url!); return true; } catch { return false; } })(), { message: 'url must be a valid URL', path: ['url'] });

export function createMcpListServersTool(manager: McpManager): Tool {
  return defineTool({
    name: 'mcp_list_servers',
    description: 'List all configured MCP servers and their connection status',
    parameters: { type: 'object', properties: {} },
    async execute(_ctx: ToolContext, _params: Record<string, unknown>) {
      const states = manager.getConnectionStates();
      if (states.size === 0) return 'No MCP servers configured.';
      const lines: string[] = [];
      for (const [name, state] of states) {
        const icon = state.status === 'connected' ? '\u2713' : state.status === 'error' ? '\u2717' : state.status === 'connecting' ? '\u2026' : '\u25CB';
        const detail = state.status === 'connected' ? `${state.capabilities.tools.length} tools, ${state.capabilities.resources.length} resources, ${state.capabilities.prompts.length} prompts` : state.status === 'error' ? state.message : '';
        lines.push(`${icon} ${name} [${state.status}]${detail ? ` \u2014 ${detail}` : ''}`);
      }
      return lines.join('\n');
    },
    readonly: true,
  });
}

export function createMcpAddServerTool(manager: McpManager, catalog: ToolCatalog, promptRegistry: McpPromptRegistry): Tool {
  return defineTool({
    name: 'mcp_add_server',
    description: 'Connect to a new MCP server and register its tools and prompts. Persisted to user settings for future sessions.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique server name (used for tool prefix)' },
        transport: { type: 'string', enum: ['stdio', 'sse', 'streamable-http'] },
        command: { type: 'string', description: 'Shell command (stdio transport only)' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments (stdio transport only)' },
        url: { type: 'string', description: 'Server URL (sse / streamable-http transport)' },
        headers: { type: 'object', description: 'HTTP headers (optional)' },
        env: { type: 'object', description: 'Environment variables (optional)' },
      },
      required: ['name', 'transport'],
    },
    async execute(_ctx: ToolContext, params: Record<string, unknown>) {
      const parsed = mcpServerConfigSchema.safeParse(params);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
        return `Error: invalid MCP server configuration:\n${issues}`;
      }
      const config = parsed.data as McpServerConfig;
      if (manager.hasServer(config.name)) {
        return `Error: MCP server '${config.name}' already connected. Use mcp_remove_server first to remove it.`;
      }
      await manager.connectServer(config);
      void persistServerConfig(config);

      const tools = manager.getServerTools(config.name);
      for (const toolDef of tools) {
        const adapter = new McpToolAdapter(manager, config.name, toolDef);
        catalog.register(adapter.toTool());
      }

      const prompts = manager.getServerPrompts(config.name);
      for (const promptDef of prompts) {
        promptRegistry.registerAsTool(config.name, promptDef, catalog);
      }

      return `Connected to '${config.name}': ${tools.length} tools, ${prompts.length} prompts registered.`;
    },
  });
}

export function createMcpRemoveServerTool(manager: McpManager, catalog: ToolCatalog): Tool {
  return defineTool({
    name: 'mcp_remove_server',
    description: 'Disconnect and unregister an MCP server. Session-only.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Server name to remove' } },
      required: ['name'],
    },
    async execute(_ctx: ToolContext, params: Record<string, unknown>) {
      const name = String(params.name);
      if (!manager.hasServer(name)) return `Error: MCP server '${name}' not found.`;
      const prefix = `mcp__${name}__`;
      for (const tool of catalog.list()) {
        if (tool.name.startsWith(prefix)) catalog.unregister(tool.name);
      }
      await manager.removeServer(name);
      void removeServerConfig(name);
      return `Removed MCP server '${name}'.`;
    },
  });
}

export function createMcpReadResourceTool(manager: McpManager): Tool {
  return defineTool({
    name: 'mcp_read_resource',
    description: 'Read the contents of an MCP resource by server name and URI.',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP server name' },
        uri: { type: 'string', description: 'Resource URI to read' },
      },
      required: ['server', 'uri'],
    },
    async execute(_ctx: ToolContext, params: Record<string, unknown>) {
      const server = String(params.server);
      const uri = String(params.uri);
      const result = await manager.readResource(server, uri);
      const callResult = result as { contents?: Array<{ text?: string; blob?: string; uri?: string; mimeType?: string }> };
      if (!callResult.contents || callResult.contents.length === 0) return `Resource '${uri}' returned empty contents.`;
      return callResult.contents.map((c) => c.text ?? `[binary data: ${c.mimeType ?? 'unknown'}, uri: ${c.uri}]`).join('\n\n');
    },
    readonly: true,
  });
}
```

- [ ] **Step 2: Rewrite mcp/tool-adapter.ts**

`McpToolAdapter` no longer implements `ToolImplementation`. Instead it's a thin wrapper that constructs a `Tool` object for catalog registration.

```ts
import type { Tool } from '../../../application/ports/tool';
import type { ToolContext } from '../../../application/ports/tool-context';
import type { McpManager } from './manager';
import type { McpToolDef } from './types';

const TOOL_PREFIX = 'mcp__';
const READONLY_PREFIXES = ['list_', 'read_', 'search_', 'get_', 'find_'];

function isReadonly(toolDef: McpToolDef): boolean {
  return READONLY_PREFIXES.some((prefix) => toolDef.name.startsWith(prefix));
}

export function formatToolName(serverName: string, toolName: string): string {
  return `${TOOL_PREFIX}${serverName}__${toolName}`;
}

export class McpToolAdapter {
  constructor(
    private manager: McpManager,
    private serverName: string,
    private toolDef: McpToolDef,
  ) {}

  toTool(): Tool {
    return {
      name: formatToolName(this.serverName, this.toolDef.name),
      description: this.toolDef.description ?? `MCP tool '${this.toolDef.name}' from server '${this.serverName}'`,
      parameters: this.toolDef.parameters,
      execute: async (ctx: ToolContext, params: Record<string, unknown>) => {
        const result = await this.manager.executeTool(this.serverName, this.toolDef.name, params, ctx.signal);
        return this.unwrapContent(result);
      },
      readonly: isReadonly(this.toolDef),
      conflictKey: isReadonly(this.toolDef) ? () => null : () => `mcp:${this.serverName}`,
    };
  }

  private unwrapContent(result: unknown): string {
    const cr = result as { content?: Array<{ type: string; text?: string; mimeType?: string; resource?: unknown }>; isError?: boolean };
    if (!cr.content || cr.content.length === 0) return cr.isError ? '[MCP tool error]' : '';
    const texts: string[] = [];
    for (const block of cr.content) {
      if (block.type === 'text' && block.text !== undefined) texts.push(block.text);
      else if (block.type === 'image') {
        const data = (block as { data?: string }).data;
        texts.push(`[image: ${block.mimeType || 'unknown'}${typeof data === 'string' ? `, ${data.length} bytes base64` : ''}]`);
      } else if (block.type === 'resource') texts.push(JSON.stringify(block.resource));
    }
    const output = texts.join('\n');
    return cr.isError ? `[MCP tool error]\n${output}` : output;
  }
}
```

- [ ] **Step 3: Rewrite mcp/prompt-registry.ts**

`McpPromptTool` no longer implements `ToolImplementation`. `McpPromptRegistry.registerAsTool` takes a `ToolCatalog`.

```ts
import type { Tool } from '../../../application/ports/tool';
import type { ToolContext } from '../../../application/ports/tool-context';
import type { McpManager } from './manager';
import type { McpPromptDef } from './types';
import type { ToolCatalog } from '../../../application/ports/tool-catalog';
import { formatToolName } from './tool-adapter';

function createPromptTool(manager: McpManager, serverName: string, promptDef: McpPromptDef): Tool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const arg of promptDef.arguments || []) {
    properties[arg.name] = { type: 'string', description: arg.description || arg.name };
    if (arg.required) required.push(arg.name);
  }
  return {
    name: formatToolName(serverName, `prompt__${promptDef.name}`),
    description: promptDef.description ?? `MCP prompt '${promptDef.name}' from server '${serverName}'`,
    parameters: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
    execute: async (_ctx: ToolContext, params: Record<string, unknown>) => {
      const stringArgs: Record<string, string> = {};
      for (const [key, value] of Object.entries(params)) stringArgs[key] = String(value);
      const result = await manager.getPrompt(serverName, promptDef.name, stringArgs);
      return result.messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n');
    },
  };
}

export class McpPromptRegistry {
  constructor(private manager: McpManager) {}

  getAll(): Array<{ serverName: string; prompt: McpPromptDef }> {
    return this.manager.getAllPrompts();
  }

  registerAsTool(serverName: string, promptDef: McpPromptDef, catalog: ToolCatalog): void {
    catalog.register(createPromptTool(this.manager, serverName, promptDef));
  }
}
```

- [ ] **Step 4: Delete mcp/tool-registry.ts**

```bash
rm src/extensions/mcp/mcp/tool-registry.ts
```

- [ ] **Step 5: Update mcp/index.ts — remove ToolRegistry, use ToolCatalog**

Remove all `ToolRegistry` references. Remove the `McpListServersTool`/etc class imports. In `apply()`, get catalog and register static MCP tools:

```ts
// In apply(), add after manager creation:
const catalog = ctx.extensions.get<ToolCatalog>('tool-catalog.catalog');
const promptRegistry = new McpPromptRegistry(manager);

// Register static MCP tools
catalog.register(createMcpListServersTool(manager));
catalog.register(createMcpReadResourceTool(manager));
catalog.register(createMcpAddServerTool(manager, catalog, promptRegistry));
catalog.register(createMcpRemoveServerTool(manager, catalog));
```

Update imports accordingly. Remove `resolveTools` hook from MCP extension entirely — tools are now in the catalog and the catalog's `resolveTools` handles discovery.

- [ ] **Step 6: Verify compilation**

Run: `bun run tsc --noEmit 2>&1 | head -20`

- [ ] **Step 7: Commit**

```bash
git add src/extensions/mcp/mcp/tools.ts src/extensions/mcp/mcp/tool-adapter.ts src/extensions/mcp/mcp/prompt-registry.ts src/extensions/mcp/index.ts
git rm src/extensions/mcp/mcp/tool-registry.ts
git commit -m "refactor(p7): migrate MCP tools to defineTool, delete ToolRegistry, use central catalog"
```

---

### Task 16: Delete MemoryTool and CreateReviewSkillTool (dead code)

**Files:**
- Delete: `src/extensions/memory/memory/tool.ts`
- Delete: `src/extensions/evolution/evolution/review-tools.ts`
- Modify: `src/extensions/memory/memory/index.ts` (remove `export { MemoryTool }`)
- Modify: `src/extensions/evolution/evolution/index.ts` (remove `export { CreateReviewSkillTool }`)

- [ ] **Step 1: Delete dead files and remove exports**

```bash
rm src/extensions/memory/memory/tool.ts
rm src/extensions/evolution/evolution/review-tools.ts
```

Edit `src/extensions/memory/memory/index.ts`: remove line `export { MemoryTool } from './tool';`

Edit `src/extensions/evolution/evolution/index.ts`: remove line `export { CreateReviewSkillTool } from './review-tools';`

- [ ] **Step 2: Verify compilation**

Run: `bun run tsc --noEmit 2>&1 | head -20`
Expected: clean compile (all ZodTool references now gone).

- [ ] **Step 3: Commit**

```bash
git rm src/extensions/memory/memory/tool.ts src/extensions/evolution/evolution/review-tools.ts
git add src/extensions/memory/memory/index.ts src/extensions/evolution/evolution/index.ts
git commit -m "chore(p7): delete MemoryTool and CreateReviewSkillTool — dead code with zero consumers"
```

---

### Task 17: Update types.ts — delete Tool/ToolImplementation/ToolContext re-exports

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Remove deprecated re-exports**

Remove lines 5-6 from types.ts:
```ts
/** @deprecated import from application/ports/tool-context */
export type { ToolContext, Tool, ToolImplementation } from './application/ports/tool-context'
```

- [ ] **Step 2: Update all 15+ import sites**

Find all files that import `Tool`, `ToolImplementation`, or `ToolContext` from `types.ts` and redirect to `application/ports/tool` or `application/ports/tool-context`:

Files to update — run:
```bash
grep -rn "from '.*types'" src/extensions/ src/application/ src/infrastructure/ src/domain/ | grep -E "(Tool|ToolContext|ToolImplementation)"
```

Update each:
- `import type { Tool, ToolImplementation } from '../../../types'` → `import type { Tool } from '../../../application/ports/tool'`
- `import type { ToolContext } from '../../../types'` → `import type { ToolContext } from '../../../application/ports/tool-context'`

- [ ] **Step 3: Verify clean compile**

Run: `bun run tsc --noEmit 2>&1 | grep -c error`
Expected: 0 (or only pre-existing errors unrelated to this change).

- [ ] **Step 4: Verify no Tool/ToolImplementation imports from types.ts remain**

Run: `grep -rn "Tool\|ToolImplementation\|ToolContext" src/ --include="*.ts" | grep "from '.*types'" | grep -v node_modules`
Expected: 0 results.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts  # plus all files with updated import paths
git commit -m "chore(p7): delete Tool/ToolImplementation/ToolContext re-exports from types.ts"
```

---

### Task 18: Update run-turn.ts — construct ToolContext

**Files:**
- Modify: `src/application/usecases/run-turn.ts`
- Modify: `src/domain/turn-runner.types.ts`

Update `RunTurnHooks.onToolCall` to accept a `ToolContext` second argument instead of `{ sessionId, turnId }`. Construct `ToolContext` in `runTurnUsecase` and pass through.

- [ ] **Step 1: Update RunTurnHooks in turn-runner.types.ts**

```ts
import type { ToolContext } from '../../application/ports/tool-context'

export interface RunTurnHooks {
  onToolCall(call: ToolCall, ctx: ToolContext): Promise<unknown>
}
```

- [ ] **Step 2: Update RunTurnUsecaseDeps to include profileDir**

Add `profileDir: string` to `RunTurnUsecaseDeps`:
```ts
export interface RunTurnUsecaseDeps {
  // ... existing fields ...
  profileDir: string
}
```

- [ ] **Step 3: Update buildRunTurnDeps**

```ts
export function buildRunTurnDeps(ctx: { /* ... */ profileDir: string }): RunTurnUsecaseDeps {
  return {
    // ... existing ...
    profileDir: ctx.profileDir,
  }
}
```

- [ ] **Step 4: In runTurnUsecase, construct ToolContext after resolveTools**

```ts
const toolCtx: ToolContext = {
  signal: new AbortController().signal, // placeholder until Track C
  environment: { cwd: deps.profileDir },
}
```

- [ ] **Step 5: Pass toolCtx to onToolCall hook in runTurn() call**

Change:
```ts
hooks: {
  onToolCall: async (call, ctx) =>
    hooks.dispatch('onToolCall', call, ctx),
},
```
to:
```ts
hooks: {
  onToolCall: async (call, _unused) =>
    hooks.dispatch('onToolCall', call, toolCtx),
},
```

- [ ] **Step 6: Update turn-runner.ts to pass toolCtx**

In `turn-runner.ts` line 78, the call `hooks.onToolCall(call, { sessionId, turnId })` now receives and passes through the `ToolContext`. No change needed in turn-runner.ts — it already passes whatever ctx the usecase gave it.

Actually: the turn-runner still constructs `{ sessionId, turnId }` at line 78. Change to use the ctx from the hooks wrapper:

No - the hooks wrapper in run-turn.ts already ignores the turn-runner's ctx and uses `toolCtx` from the usecase. So no change needed in turn-runner.ts itself.

- [ ] **Step 7: Verify compilation**

Run: `bun run tsc --noEmit 2>&1 | head -20`

- [ ] **Step 8: Commit**

```bash
git add src/application/usecases/run-turn.ts src/domain/turn-runner.types.ts
git commit -m "feat(p7): construct ToolContext in run-turn usecase with signal + cwd"
```

---

### Task 19: Run full CI check for Track B completion

- [ ] **Step 1: Run full check**

```bash
bun run check:all
```

- [ ] **Step 2: Verify clean: no ZodTool references**

```bash
grep -r "ZodTool" src/ --include="*.ts"
```
Expected: 0 results.

- [ ] **Step 3: Verify clean: no ToolImplementation references**

```bash
grep -r "ToolImplementation" src/ --include="*.ts"
```
Expected: 0 results.

- [ ] **Step 4: Verify clean: no registerTool in tools/index.ts**

```bash
grep "registerTool" src/extensions/tools/index.ts
```
Expected: 0 results.

- [ ] **Step 5: Fix any issues, then commit if changes made**

---

## Track C: Abort End-to-End (Tasks 20–24)

### Task 20: Add AbortController management to session extension

**Files:**
- Modify: `src/extensions/session/index.ts`

- [ ] **Step 1: Add abort capability to session extension**

After the `abortControllers` declaration in `apply()`:
```ts
const abortControllers = new Map<string, AbortController>()
```

Add to the `provide` block:
```ts
abort: () => ({
  register: (sessionId: string, controller: AbortController) => {
    abortControllers.set(sessionId, controller)
  },
  unregister: (sessionId: string) => {
    abortControllers.delete(sessionId)
  },
  abort: (sessionId: string) => {
    abortControllers.get(sessionId)?.abort()
  },
}),
```

Update the JSDoc capabilities comment at top of the extension to include `session.abort`.

- [ ] **Step 2: Verify compilation**

Run: `bun run tsc --noEmit 2>&1 | head -10`

- [ ] **Step 3: Commit**

```bash
git add src/extensions/session/index.ts
git commit -m "feat(p7): add AbortController management to session extension"
```

---

### Task 21: Wire abort signal through run-turn → provider + dispatch-tool + turn-runner

**Files:**
- Modify: `src/application/usecases/run-turn.ts`
- Modify: `src/domain/turn-runner.ts`

- [ ] **Step 1: In run-turn.ts, get session abort capability and create controller**

Replace the placeholder `new AbortController().signal` with a session-managed controller:

```ts
// In runTurnUsecase, before Phase 4:
const sessionAbort = deps.sessionAbort // new dep — see below
const controller = new AbortController()
sessionAbort.register(sessionId, controller)

const toolCtx: ToolContext = {
  signal: controller.signal,
  environment: { cwd: deps.profileDir },
}
```

Add `sessionAbort` to `RunTurnUsecaseDeps`:
```ts
export interface RunTurnUsecaseDeps {
  // ... existing fields ...
  sessionAbort: {
    register(sessionId: string, controller: AbortController): void
    unregister(sessionId: string): void
  }
}
```

Add `sessionAbort` to `buildRunTurnDeps`:
```ts
sessionAbort: ctx.extensions.get<RunTurnUsecaseDeps['sessionAbort']>('session.abort'),
```

Wrap the try/finally around the turn execution:
```ts
try {
  for await (const event of runTurn({ /* ... */ })) {
    // ...
  }
} catch (err) {
  // ...
} finally {
  sessionAbort.unregister(sessionId)
}
```

- [ ] **Step 2: Pass signal to provider.stream()**

The provider's `stream()` already accepts `AbortSignal` — pass it:
```ts
// In run-turn.ts, when calling runTurn():
// Add abortSignal to deps:
for await (const event of runTurn({
  sessionId, turnId,
  messages: finalMessages,
  tools: toolsR.value,
  provider,
  hooks: { onToolCall: async (call, _unused) => hooks.dispatch('onToolCall', call, toolCtx) },
  maxIterations: 10,
  abortSignal: controller.signal,
})) {
```

- [ ] **Step 3: In turn-runner.ts, use abortSignal in provider.stream() call**

Change line 55-57:
```ts
const round = yield* consumeRound(
  provider.stream({ messages: currentMessages, tools, signal: deps.abortSignal }),
  { sessionId, turnId },
)
```

- [ ] **Step 4: Add abort check between iterations in turn-runner.ts**

After the for loop header (line 54), add:
```ts
if (deps.abortSignal?.aborted) break
```

This is the turn-runner兜底 — even if provider.stream doesn't respect the signal, the loop breaks at the next iteration.

- [ ] **Step 5: Verify compilation**

Run: `bun run tsc --noEmit 2>&1 | head -20`

- [ ] **Step 6: Commit**

```bash
git add src/application/usecases/run-turn.ts src/domain/turn-runner.ts
git commit -m "feat(p7): wire abort signal through run-turn → provider + turn-runner兜底"
```

---

### Task 22: Wire input.cancel RPC to trigger session abort

**Files:**
- Modify: `src/extensions/controlplane/methods.ts`

- [ ] **Step 1: Update input.cancel handler to call session.abort**

In the `input.cancel` RPC handler (around line 184), add before the existing logic:

```ts
'input.cancel': async (params: unknown) => {
  const p = params as { sessionId?: string; reason?: string } | undefined
  const sessionId = p?.sessionId ?? 'main'
  const reason = p?.reason ?? 'user requested'

  // Trigger abort signal to stop running turn
  try {
    const sessionAbort = ctx.extensions.get<{
      abort(sessionId: string): void
    }>('session.abort')
    sessionAbort.abort(sessionId)
  } catch { /* session.abort may not be registered yet */ }

  contractBus.emit(createEvent('input.cancelled', { sessionId, reason }))

  const store = getStore()
  const session = await store.load(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)

  if (session.state === 'RUNNING') {
    session.pendingInputs.length = 0
    try { session.completeTurn() } catch { /* may already be IDLE */ }
    await store.save(session)
    contractBus.emit(createEvent('turn.cancelled', { sessionId, reason }))
  }
  return { cancelled: true, sessionId, reason }
},
```

Previously the raw emits were lines 191 and 196, but these have already been converted to contractBus in Task 4.

- [ ] **Step 2: Verify compilation**

Run: `bun run tsc --noEmit 2>&1 | head -10`

- [ ] **Step 3: Commit**

```bash
git add src/extensions/controlplane/methods.ts
git commit -m "feat(p7): wire input.cancel RPC to trigger session abort"
```

---

### Task 23: Update presets to include tool-catalog dependency

**Files:**
- Modify: `src/extensions/presets.ts`

Ensure `tool-catalog` extension is registered before `tools` and `mcp` in the `domainCore` preset. The `tool-catalog` extension has `enforce: 'pre'` so it must come before `tools` in the array.

- [ ] **Step 1: Add import and insert into domainCore**

Add import after the existing extension imports:
```ts
import toolCatalogExt from './tool-catalog'
```

Insert `toolCatalogExt()` at the start of `domainCore` (before `traceExt()`):
```ts
export const domainCore = [toolCatalogExt(), traceExt(), providerExt(), sessionExt(), toolsExt(), permissionExt(), controlplaneExt(), controlplaneMethodsExt(), dataplaneExt()]
```

- [ ] **Step 2: Verify compilation**

Run: `bun run tsc --noEmit 2>&1 | head -10`

- [ ] **Step 3: Commit**

```bash
git add src/extensions/presets.ts
git commit -m "feat(p7): add tool-catalog extension to all presets"
```

---

### Task 24: Full CI verification + manual verification

- [ ] **Step 1: Run full CI check**

```bash
bun run check:all
```
Expected: green.

- [ ] **Step 2: Verify A5 guard — 0 exemption files**

Run: `grep "A5_WHITELIST_FILES" scripts/check-architecture.ts`
Expected: `const A5_WHITELIST_FILES = new Set(['dataplane/index.ts']);`
Only dataplane remains (it's a forwarding bridge, legitimate exemption).

- [ ] **Step 3: Manual verification checklist**

Run each:
```bash
# 1. No raw emits in controlplane
grep "ctx.bus.emit(" src/extensions/controlplane/methods.ts
# Expected: 0 results

# 2. No registerTool in tools index
grep "registerTool" src/extensions/tools/index.ts
# Expected: 0 results

# 3. No ZodTool anywhere
grep -r "ZodTool" src/ --include="*.ts"
# Expected: 0 results

# 4. No ToolImplementation anywhere
grep -r "ToolImplementation" src/ --include="*.ts"
# Expected: 0 results

# 5. No Tool/ToolImplementation/ToolContext import from types.ts
grep -rn "from '.*types'" src/ --include="*.ts" | grep -E "(Tool|ToolContext|ToolImplementation)"
# Expected: 0 results

# 6. tool-catalog extension exists
ls src/extensions/tool-catalog/index.ts
# Expected: file exists

# 7. tools/ directory is flat (no tools/tools/ nesting)
ls src/extensions/tools/tools/ 2>&1
# Expected: directory does not exist or is empty
```

- [ ] **Step 4: Run tests**

```bash
bun test
```
Expected: all passing.

- [ ] **Step 5: Commit any final fixes**

```bash
git add -A
git commit -m "chore(p7): final cleanup and verification fixes"
```
