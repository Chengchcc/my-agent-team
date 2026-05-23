# P-5 — Schema + DataPlane 收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将跨边界数据契约（DataPlane event、ControlPlane message、persistent record）的主权从 extension internals 上收到 `application/contracts/**`，消除 ports/frontend/transport 对 extension 类型的直接依赖。

**Architecture:** 新增 `application/contracts/` 层作为公共数据契约的唯一主权地。`EventEnvelope` 提供统一的 versioned wrapper，所有跨边界事件通过 `createEvent()` factory 组装。DataPlane extension 保留桥接逻辑，但类型定义权上收。zod 仅用于 contracts 层 codec 校验，不扩散。

**Tech Stack:** TypeScript, zod (contracts only), ESLint no-restricted-imports, ts-morph (architecture checks)

**Locked decisions (from grill-me):**
- zod only in contracts, architecture guard prevents spread
- Direct delete event-types.ts + jsonrpc.ts, no re-export shims
- Deprecate evolution.summary.request (no emit point → dead subscription)
- ContentBlock: pure move to contracts, no ceremony
- History record: write v1 directly, old records skip+warn
- DataPlaneEvent extends EventEnvelope, adds evId/cursor
- All 16 DataPlaneEvent types preserved
- llm.delta split into contracted `llm.delta` + internal `provider.stream.chunk`
- createEventFactory stays in dataplane extension
- Contract provides createEvent() factory, extensions call it to emit
- Frontend continues consuming only via dataplane facade
- All dataplane-mapped events contracted in P-5
- Non-first-batch events: schema-ify current payload with minimal trim
- Import guards → ESLint, definition guards → check-architecture.ts

---

## File Structure

### New files (15)

```
src/application/contracts/
  index.ts                       — barrel export
  event-envelope.ts              — EventEnvelope<TType, TPayload> + createEvent()
  dataplane-event.ts             — DataPlaneEventType (16), DataPlaneEvent extends EventEnvelope
  controlplane.ts                — Full mirror of jsonrpc.ts types + helpers
  content-block.ts               — ContentBlock pure move from src/types.ts
  provider-events.ts             — ProviderSelectedV1, LlmDeltaV1
  memory-events.ts               — MemorySummaryReadyV1, MemorySummarizedV1
  evolution-events.ts            — EvolutionProposalAcceptedV1, EvolutionProposalRejectedV1, SkillsReloadedV1
  session-events.ts              — SessionCreatedV1, TurnStartedV1, TurnCompletedV1
  tool-events.ts                 — ToolExecutedV1
  permission-events.ts           — PermissionRequiredV1
  identity-events.ts             — IdentityChangedV1
  history-record.ts              — HistoryRecordV1 (unified from 3 duplicate types)
  shared/
    versioned.ts                 — VERSION constant, Versioned<T> wrapper
    codec.ts                     — createCodec(schema) → { encode, decode, safeDecode }
```

### Modified files (14)

```
src/types.ts                     — remove ContentBlock
src/extensions/dataplane/index.ts— import contracts, keep createEventFactory + bridge logic
src/application/ports/transport.ts— import from contracts, remove eslint-disable
src/core/frontend/handle.ts      — import from contracts, remove eslint-disable
src/infrastructure/transport/inmem-transport.ts — import from contracts, remove eslint-disable
src/infrastructure/transport/unix-socket-transport.ts — import from contracts, remove eslint-disable
src/extensions/provider/index.ts — import contracts, emit contracted events, add provider.stream.chunk
src/extensions/memory/index.ts   — import contracts, emit contracted events, remove evolution.summary.request
src/extensions/evolution/index.ts— import contracts, emit contracted events
src/extensions/session/index.ts  — import contracts + HistoryRecordV1, emit contracted events, write v1 records
src/extensions/frontend.tui/index.ts — import from contracts
src/extensions/frontend.lark/index.ts — import from contracts
src/extensions/transport.unix/index.ts — (check if it imports DataPlaneEvent)
src/application/usecases/append-history.ts — import HistoryRecordV1 from contracts
src/application/usecases/run-turn.ts — import HistoryRecordV1 for MessageStorePort
eslint.config.js                 — add contracts guard rules
scripts/check-architecture.ts    — add data ownership guard rules
```

### Deleted files (2)

```
src/extensions/dataplane/event-types.ts
src/extensions/controlplane/jsonrpc.ts
```

---

### Task 1: Contracts foundation — shared utilities + event envelope

**Files:**
- Create: `src/application/contracts/shared/versioned.ts`
- Create: `src/application/contracts/shared/codec.ts`
- Create: `src/application/contracts/event-envelope.ts`

- [ ] **Step 1: Create `shared/versioned.ts`**

```typescript
/** Current contract version. All versioned records/envelopes use this. */
export const CONTRACT_VERSION = 1 as const;

/** Wrapper for any versioned payload. */
export interface Versioned<T> {
  version: typeof CONTRACT_VERSION;
  data: T;
}
```

- [ ] **Step 2: Create `shared/codec.ts`**

```typescript
import { z } from 'zod';

/**
 * Result of safeDecode — discriminated union so callers can narrow
 * without catching exceptions.
 */
export type DecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Create a symmetric encode/decode pair from a zod schema.
 * - `encode` never fails (zod .parse throws if schema violated, which indicates a code bug)
 * - `decode` returns null on any failure (malformed input, wrong shape, etc.)
 * - `safeDecode` returns a discriminated result for fail-soft callers.
 */
export function createCodec<T>(schema: z.ZodType<T>) {
  return {
    encode(value: T): unknown {
      return schema.parse(value) as unknown;
    },
    decode(raw: unknown): T | null {
      const result = schema.safeParse(raw);
      return result.success ? result.data : null;
    },
    safeDecode(raw: unknown): DecodeResult<T> {
      const result = schema.safeParse(raw);
      return result.success
        ? { ok: true, value: result.data }
        : { ok: false, error: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
    },
  };
}
```

- [ ] **Step 3: Create `event-envelope.ts`**

```typescript
import type { KernelContext } from '../../kernel/kernel-context';

/**
 * Every cross-boundary observable event is wrapped in this versioned envelope.
 * sessionId / turnId are provided by the envelope so individual payloads
 * don't need to repeat them.
 */
export interface EventEnvelope<TType extends string, TPayload = Record<string, unknown>> {
  type: TType;
  version: 1;
  ts: number;
  sessionId?: string;
  turnId?: string;
  payload: TPayload;
}

/**
 * Factory options — populated from KernelContext at emit time.
 */
export interface CreateEventOpts {
  sessionId?: string;
  turnId?: string;
}

/**
 * Create a contracted event envelope. Called by extensions at emit points.
 * `ctx` provides sessionId/turnId when available.
 */
export function createEvent<TType extends string, TPayload>(
  type: TType,
  payload: TPayload,
  opts?: CreateEventOpts,
): EventEnvelope<TType, TPayload> {
  return {
    type,
    version: 1,
    ts: Date.now(),
    sessionId: opts?.sessionId,
    turnId: opts?.turnId,
    payload,
  };
}
```

- [ ] **Step 4: Commit**

```bash
git add src/application/contracts/shared/versioned.ts src/application/contracts/shared/codec.ts src/application/contracts/event-envelope.ts
git commit -m "feat(p5): add contracts foundation — versioned, codec, event-envelope"
```

---

### Task 2: Contracts — DataPlane event types + ControlPlane mirror + ContentBlock

**Files:**
- Create: `src/application/contracts/dataplane-event.ts`
- Create: `src/application/contracts/controlplane.ts`
- Create: `src/application/contracts/content-block.ts`
- Create: `src/application/contracts/index.ts`

- [ ] **Step 1: Create `dataplane-event.ts`**

```typescript
import type { EventEnvelope } from './event-envelope';

/** All 16 DataPlane event types — the complete set, including forward-looking types. */
export type DataPlaneEventType =
  | 'snapshot'
  | 'assistant.delta'
  | 'tool.update'
  | 'permission.required'
  | 'user.question'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.failed'
  | 'state.changed'
  | 'attach.changed'
  | 'identity.changed'
  | 'skills.reloaded'
  | 'mcp.reloaded'
  | 'evolution.progress'
  | 'evolution.skillProposed'
  | 'system.warn';

/**
 * DataPlaneEvent — the unified event type consumed by frontends via the
 * dataplane facade. Extends EventEnvelope and adds streaming-specific fields.
 */
export interface DataPlaneEvent extends EventEnvelope<DataPlaneEventType> {
  /** Monotonic event id, assigned by dataplane bridge */
  evId: string;
  /** Monotonic cursor for replay/gap-detection */
  cursor: number;
  /** Frontend target id for targeted events */
  target?: string;
}
```

- [ ] **Step 2: Create `controlplane.ts`** — full mirror of `src/extensions/controlplane/jsonrpc.ts`

```typescript
// ── JSON-RPC 2.0 message types ────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ── Standard error codes ──────────────────────────────────────────────────────

export const JSONRPC_ERRORS = {
  PARSE_ERROR: { code: -32700, message: 'Parse error' },
  INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
  SESSION_NOT_FOUND: { code: -32000, message: 'Session not found' },
  SESSION_BUSY: { code: -32001, message: 'Session busy' },
  PERMISSION_TARGET_MISMATCH: { code: -32002, message: 'Permission target mismatch' },
} as const;

export type JsonRpcErrorCode = (typeof JSONRPC_ERRORS)[keyof typeof JSONRPC_ERRORS];

// ── Type guards / builders ────────────────────────────────────────────────────

export function isRequest(msg: unknown): msg is JsonRpcRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as Record<string, unknown>).jsonrpc === '2.0' &&
    typeof (msg as Record<string, unknown>).method === 'string'
  );
}

export function isNotification(msg: JsonRpcRequest): boolean {
  return msg.id === undefined;
}

export function buildSuccess(
  id: string | number | null,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function buildError(
  id: string | number | null,
  error: JsonRpcErrorCode,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { ...error, data } };
}
```

- [ ] **Step 3: Create `content-block.ts`** — pure move from `src/types.ts:38-43`

```typescript
/**
 * ContentBlock — structured content from LLM providers.
 * Pure data type, no ceremony (no zod, no version).
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
```

- [ ] **Step 4: Create `index.ts`** — barrel export

```typescript
// Event envelope
export type { EventEnvelope, CreateEventOpts } from './event-envelope';
export { createEvent } from './event-envelope';

// DataPlane
export type { DataPlaneEvent, DataPlaneEventType } from './dataplane-event';

// ControlPlane (JSON-RPC 2.0)
export type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  JsonRpcNotification,
  JsonRpcMessage,
  JsonRpcErrorCode,
} from './controlplane';
export {
  JSONRPC_ERRORS,
  isRequest,
  isNotification,
  buildSuccess,
  buildError,
} from './controlplane';

// Content
export type { ContentBlock } from './content-block';

// Shared
export type { Versioned } from './shared/versioned';
export { CONTRACT_VERSION } from './shared/versioned';
export type { DecodeResult } from './shared/codec';
export { createCodec } from './shared/codec';
```

- [ ] **Step 5: Commit**

```bash
git add src/application/contracts/
git commit -m "feat(p5): add dataplane-event, controlplane, content-block contracts"
```

---

### Task 3: Lift DataPlane + ControlPlane ownership — delete old files, rewire imports

**Files:**
- Delete: `src/extensions/dataplane/event-types.ts`
- Delete: `src/extensions/controlplane/jsonrpc.ts`
- Modify: `src/extensions/dataplane/index.ts` — import from contracts
- Modify: `src/extensions/controlplane/index.ts` — import from contracts
- Modify: `src/application/ports/transport.ts` — import from contracts, remove eslint-disable
- Modify: `src/core/frontend/handle.ts` — import from contracts, remove eslint-disable
- Modify: `src/infrastructure/transport/inmem-transport.ts` — import from contracts, remove eslint-disable
- Modify: `src/infrastructure/transport/unix-socket-transport.ts` — import from contracts, remove eslint-disable
- Modify: `src/extensions/frontend.tui/index.ts` — import from contracts
- Modify: `src/extensions/frontend.lark/index.ts` — import from contracts

- [ ] **Step 1: Rewire `src/extensions/dataplane/index.ts`**

Replace lines 1-3:
```typescript
// OLD (delete):
import { defineExtension } from '../../kernel/define-extension'
import { createEventFactory } from './event-types'
import type { DataPlaneEvent, DataPlaneEventType } from './event-types'

// NEW:
import { defineExtension } from '../../kernel/define-extension'
import type { DataPlaneEvent, DataPlaneEventType } from '../../application/contracts'
```

The `createEventFactory` stays in this file — it's runtime code, not a contract. Move its implementation inline (copy from event-types.ts):
```typescript
// ── Event factory (runtime, not a contract) ───────────────────────────────────

function createEventFactory() {
  let cursor = 0;
  return {
    next(
      type: DataPlaneEventType,
      payload: Record<string, unknown>,
      opts?: { sessionId?: string | undefined; target?: string },
    ): DataPlaneEvent {
      cursor += 1;
      return {
        type,
        version: 1,
        ts: Date.now(),
        sessionId: opts?.sessionId,
        payload,
        evId: `ev-${cursor}`,
        cursor,
        target: opts?.target,
      };
    },
    get lastCursor(): number {
      return cursor;
    },
  };
}
```

Also add `turn.failed` to the eventMappings array (add after the `identity.changed` line):
```typescript
        ['turn.failed', 'turn.failed'],
```

- [ ] **Step 2: Rewire `src/extensions/controlplane/index.ts`**

Replace jsonrpc import:
```typescript
// OLD: import from '../../extensions/controlplane/jsonrpc'
// Find the actual import line and replace with:
import type { JsonRpcMessage, JsonRpcResponse } from '../../application/contracts';
import { isRequest, isNotification, buildSuccess, buildError, JSONRPC_ERRORS } from '../../application/contracts';
```

- [ ] **Step 3: Rewire `src/application/ports/transport.ts`**

Replace the entire file:
```typescript
import type { JsonRpcMessage, JsonRpcResponse } from '../contracts';
import type { DataPlaneEvent } from '../contracts';

/**
 * Transport port — unified interface bridging ControlPlane (JSON-RPC)
 * and DataPlane (event stream) into a single adapter that a Frontend can use.
 *
 * Implementations:
 *   - InMemoryTransport (infrastructure) — for in-process frontends (TUI, tests)
 *   - StdioTransport (future) — for stdio-based MCP-like frontends
 *   - WebSocketTransport (future) — for remote frontends
 */
interface Transport {
  /** Send JSON-RPC request and get response */
  sendRpc(message: JsonRpcMessage): Promise<JsonRpcResponse | null>;
  /** Subscribe to DataPlane events */
  onEvent(handler: (event: DataPlaneEvent) => void): () => void; // returns unsubscribe
  /** Close transport */
  close(): Promise<void>;
}

export type { Transport };
```

- [ ] **Step 4: Rewire `src/core/frontend/handle.ts`**

Replace the entire file:
```typescript
import type { DataPlaneEvent } from '../../application/contracts';

/**
 * FrontendHandle —防腐层 (anti-corruption layer) interface.
 *
 * All frontends (TUI, Lark Bot, WebUI) implement this interface.
 * AgentCore/Kernel calls this without knowing TUI vs Lark details.
 * Frontends cannot import from domains/ or extensions/ internals —
 * they only use Transport (public API) and DataPlaneEvent types.
 */
interface FrontendHandle {
  readonly id: string;
  readonly kind: 'tui' | 'lark-bot' | 'webui';

  /** Receive an event from the DataPlane */
  onAgentEvent(event: DataPlaneEvent): void;

  /** Handle user question from Agent */
  onUserQuestion?(question: string, options: string[]): Promise<string>;

  /** Handle permission request from Agent */
  onPermissionRequest?(toolName: string, summary: string): Promise<'allow' | 'deny'>;

  /** Start the frontend */
  start(): Promise<void>;

  /** Stop the frontend */
  stop(): Promise<void>;
}

export type { FrontendHandle };
```

- [ ] **Step 5: Rewire `src/infrastructure/transport/inmem-transport.ts`**

Replace import lines:
```typescript
// OLD lines 1-6:
import type { Transport } from '../../application/ports/transport'
// TODO(p-4): infra adapters should not import extension types directly
// eslint-disable-next-line no-restricted-imports
import type { JsonRpcMessage, JsonRpcResponse } from '../../extensions/controlplane/jsonrpc'
// eslint-disable-next-line no-restricted-imports
import type { DataPlaneEvent } from '../../extensions/dataplane/event-types'

// NEW:
import type { Transport } from '../../application/ports/transport';
import type { JsonRpcMessage, JsonRpcResponse } from '../../application/contracts';
import type { DataPlaneEvent } from '../../application/contracts';
```

- [ ] **Step 6: Rewire `src/infrastructure/transport/unix-socket-transport.ts`**

Replace import lines:
```typescript
// OLD (line 6-11 area):
// TODO(p-4): infra adapters should not import extension types directly
// eslint-disable-next-line no-restricted-imports
import type { JsonRpcMessage, JsonRpcResponse } from '../../extensions/controlplane/jsonrpc';
import type { DataPlaneEvent } from '../../extensions/dataplane/event-types';

// NEW:
import type { JsonRpcMessage, JsonRpcResponse } from '../../application/contracts';
import type { DataPlaneEvent } from '../../application/contracts';
```

- [ ] **Step 7: Rewire `src/extensions/frontend.tui/index.ts`**

Replace line 7:
```typescript
// OLD:
import type { DataPlaneEvent } from '../dataplane/event-types'
// NEW:
import type { DataPlaneEvent } from '../../application/contracts';
```

- [ ] **Step 8: Rewire `src/extensions/frontend.lark/index.ts`**

Replace line 6:
```typescript
// OLD:
import type { DataPlaneEvent } from '../dataplane/event-types'
// NEW:
import type { DataPlaneEvent } from '../../application/contracts';
```

- [ ] **Step 9: Check for transport.unix extension import**

```bash
grep -n "DataPlaneEvent\|event-types" src/extensions/transport.unix/index.ts
```
If it imports `DataPlaneEvent`, rewire to `../../application/contracts`.

- [ ] **Step 10: Update test imports**

```bash
# Find test files that import from deleted paths
grep -rn "extensions/dataplane/event-types\|extensions/controlplane/jsonrpc" tests/
```

Update any matches to import from `../../src/application/contracts` or `../src/application/contracts` (depending on test location).

- [ ] **Step 11: Delete old files**

```bash
rm src/extensions/dataplane/event-types.ts
rm src/extensions/controlplane/jsonrpc.ts
```

- [ ] **Step 12: Verify no remaining references to deleted files**

```bash
grep -r "extensions/dataplane/event-types" src/ || echo "No remaining refs — good"
grep -r "extensions/controlplane/jsonrpc" src/ || echo "No remaining refs — good"
```

- [ ] **Step 13: Run type check**

```bash
bun run check:guard
```
Expected: PASS (all type errors resolved)

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "feat(p5): lift DataPlane + ControlPlane type ownership to contracts"
```

---

### Task 4: Provider events contract + llm.delta split

**Files:**
- Create: `src/application/contracts/provider-events.ts`
- Modify: `src/application/contracts/index.ts` — add provider-events exports
- Modify: `src/extensions/provider/index.ts` — emit contracted events

- [ ] **Step 1: Create `provider-events.ts`**

```typescript
import { z } from 'zod';
import { createCodec } from './shared/codec';

// ── provider.selected ─────────────────────────────────────────────────────────

export interface ProviderSelectedV1 {
  providerId: string;
  model: string;
  mode?: 'stream' | 'call' | 'both';
}

export const providerSelectedCodec = createCodec<ProviderSelectedV1>(
  z.object({
    providerId: z.string(),
    model: z.string(),
    mode: z.enum(['stream', 'call', 'both']).optional(),
  }),
);

// ── llm.delta ─────────────────────────────────────────────────────────────────

export interface LlmDeltaV1 {
  delta: string;
}

export const llmDeltaCodec = createCodec<LlmDeltaV1>(
  z.object({
    delta: z.string(),
  }),
);
```

- [ ] **Step 2: Update contracts `index.ts`**

Add after existing exports:
```typescript
// Provider events
export type { ProviderSelectedV1, LlmDeltaV1 } from './provider-events';
export { providerSelectedCodec, llmDeltaCodec } from './provider-events';
```

- [ ] **Step 3: Modify `src/extensions/provider/index.ts`**

Change the emit points. Replace `kernelReady` block (lines 68-73):
```typescript
// OLD:
kernelReady: {
  enforce: 'normal',
  fn: async () => {
    const info = provider as unknown as { providerId: string; model: string }
    ctx.bus.emit('provider.selected', { providerId: info.providerId, model: info.model })
  },
},

// NEW:
kernelReady: {
  enforce: 'normal',
  fn: async () => {
    const info = provider as unknown as { providerId: string; model: string };
    ctx.bus.emit('provider.selected', createEvent('provider.selected', {
      providerId: info.providerId,
      model: info.model,
    }));
  },
},
```

Add import at top:
```typescript
import { createEvent } from '../../application/contracts';
```

Replace `onLLMDelta` block (lines 75-80):
```typescript
// OLD:
onLLMDelta: {
  enforce: 'normal',
  fn: async (chunk: unknown) => {
    ctx.bus.emit('llm.delta', chunk)
  },
},

// NEW:
onLLMDelta: {
  enforce: 'normal',
  fn: async (chunk: unknown) => {
    // Internal event for raw provider chunks (not contracted)
    ctx.bus.emit('provider.stream.chunk', chunk);
  },
},
```

Note: The `llm.delta` contracted event is emitted by the turn-runner (via usecase `run-turn.ts`), NOT by the provider extension. The provider extension now emits `provider.stream.chunk` (internal, uncontracted) for raw chunks. The run-turn.ts usecase already emits `llm.delta` on the bus via `ctx.bus.emit(event.type, event)` where `event` comes from the turn-runner's yield of `{ type: 'llm.delta', ...ids, delta: chunk.delta }`.

- [ ] **Step 4: Run type check**

```bash
bun run check:guard
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/application/contracts/provider-events.ts src/application/contracts/index.ts src/extensions/provider/index.ts
git commit -m "feat(p5): contract provider.selected + split llm.delta from provider.stream.chunk"
```

---

### Task 5: Memory events contract + evolution.summary.request deprecation

**Files:**
- Create: `src/application/contracts/memory-events.ts`
- Modify: `src/application/contracts/index.ts` — add memory-events exports
- Modify: `src/extensions/memory/index.ts` — emit contracted events, remove dead subscription

- [ ] **Step 1: Create `memory-events.ts`**

```typescript
import { z } from 'zod';
import { createCodec } from './shared/codec';

// ── memory.summary.ready ──────────────────────────────────────────────────────

export interface MemorySummaryReadyV1 {
  turnId: string;
  sessionId: string;
  summary: {
    text: string;
    weight: number;
    tags: string[];
  };
}

export const memorySummaryReadyCodec = createCodec<MemorySummaryReadyV1>(
  z.object({
    turnId: z.string(),
    sessionId: z.string(),
    summary: z.object({
      text: z.string(),
      weight: z.number(),
      tags: z.array(z.string()),
    }),
  }),
);

// ── memory.summarized ─────────────────────────────────────────────────────────

export interface MemorySummarizedV1 {
  turnId: string;
}

export const memorySummarizedCodec = createCodec<MemorySummarizedV1>(
  z.object({
    turnId: z.string(),
  }),
);
```

- [ ] **Step 2: Update contracts `index.ts`**

Add:
```typescript
// Memory events
export type { MemorySummaryReadyV1, MemorySummarizedV1 } from './memory-events';
export { memorySummaryReadyCodec, memorySummarizedCodec } from './memory-events';
```

- [ ] **Step 3: Modify `src/extensions/memory/index.ts`**

Add import:
```typescript
import { createEvent } from '../../application/contracts';
```

Change `onTurnEnd` (line 58):
```typescript
// OLD:
ctx.bus.emit('memory.summarized', { turnId: r.turnId })

// NEW:
ctx.bus.emit('memory.summarized', createEvent('memory.summarized', { turnId: r.turnId }))
```

Change `memory.summary.ready` emit (lines 120-124):
```typescript
// OLD:
ctx.bus.emit('memory.summary.ready', {
  turnId: e.turnId,
  sessionId: e.sessionId,
  summary,
})

// NEW:
ctx.bus.emit('memory.summary.ready', createEvent('memory.summary.ready', {
  turnId: e.turnId,
  sessionId: e.sessionId,
  summary,
}))
```

Remove the dead `'evolution.summary.request'` subscription (lines 91-125). The entire subscribe block for `'evolution.summary.request'` is dead code (zero emit points in codebase).

Also update the comment block (lines 9-10):
```typescript
// OLD:
// Memory ↔ Evolution decoupled via EventBus:
//   evolution.summary.request → memory processes → memory.summary.ready

// NEW:
// Memory summarization runs on turn end. Summaries are emitted as
// contracted events (memory.summary.ready / memory.summarized).
```

Remove unused import `summarizeForMemory` since it was only used in the deleted `evolution.summary.request` handler (line 4).

- [ ] **Step 4: Run type check**

```bash
bun run check:guard
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/application/contracts/memory-events.ts src/application/contracts/index.ts src/extensions/memory/index.ts
git commit -m "feat(p5): contract memory events, deprecate evolution.summary.request"
```

---

### Task 6: Evolution events contract

**Files:**
- Create: `src/application/contracts/evolution-events.ts`
- Modify: `src/application/contracts/index.ts` — add evolution-events exports
- Modify: `src/extensions/evolution/index.ts` — emit contracted events

- [ ] **Step 1: Create `evolution-events.ts`**

```typescript
import { z } from 'zod';
import { createCodec } from './shared/codec';

// ── evolution.proposal.accepted ───────────────────────────────────────────────

export interface EvolutionProposalAcceptedV1 {
  id: string;
}

export const evolutionProposalAcceptedCodec = createCodec<EvolutionProposalAcceptedV1>(
  z.object({
    id: z.string(),
  }),
);

// ── evolution.proposal.rejected ───────────────────────────────────────────────

export interface EvolutionProposalRejectedV1 {
  id: string;
  reason?: string;
}

export const evolutionProposalRejectedCodec = createCodec<EvolutionProposalRejectedV1>(
  z.object({
    id: z.string(),
    reason: z.string().optional(),
  }),
);

// ── skills.reloaded ───────────────────────────────────────────────────────────

export interface SkillsReloadedV1 {
  added: string[];
  removed: string[];
  updated: string[];
}

export const skillsReloadedCodec = createCodec<SkillsReloadedV1>(
  z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    updated: z.array(z.string()),
  }),
);
```

- [ ] **Step 2: Update contracts `index.ts`**

Add:
```typescript
// Evolution events
export type {
  EvolutionProposalAcceptedV1,
  EvolutionProposalRejectedV1,
  SkillsReloadedV1,
} from './evolution-events';
export {
  evolutionProposalAcceptedCodec,
  evolutionProposalRejectedCodec,
  skillsReloadedCodec,
} from './evolution-events';
```

- [ ] **Step 3: Modify `src/extensions/evolution/index.ts`**

Add import:
```typescript
import { createEvent } from '../../application/contracts';
```

Change emits in `acceptProposal` (lines 98-99):
```typescript
// OLD:
ctx.bus.emit('evolution.proposal.accepted', { id })
ctx.bus.emit('skills.reloaded', { added: [proposal.name], removed: [], updated: [] })

// NEW:
ctx.bus.emit('evolution.proposal.accepted', createEvent('evolution.proposal.accepted', { id }));
ctx.bus.emit('skills.reloaded', createEvent('skills.reloaded', {
  added: [proposal.name],
  removed: [],
  updated: [],
}));
```

Change emit in `rejectProposal` (line 106):
```typescript
// OLD:
if (ok) ctx.bus.emit('evolution.proposal.rejected', { id, reason })

// NEW:
if (ok) ctx.bus.emit('evolution.proposal.rejected', createEvent('evolution.proposal.rejected', { id, reason }));
```

Also check the skills extension for `skills.reloaded` emit — it emits independently:
```typescript
// In src/extensions/skills/index.ts, find the emit and wrap with createEvent
```

- [ ] **Step 4: Check and update `src/extensions/skills/index.ts`**

```bash
grep -n "skills.reloaded" src/extensions/skills/index.ts
```
If it emits `skills.reloaded` directly, add `import { createEvent } from '../../application/contracts'` and wrap the emit.

- [ ] **Step 5: Run type check**

```bash
bun run check:guard
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/application/contracts/evolution-events.ts src/application/contracts/index.ts src/extensions/evolution/index.ts src/extensions/skills/index.ts
git commit -m "feat(p5): contract evolution events — proposal.accepted, proposal.rejected, skills.reloaded"
```

---

### Task 7: Session + tool + permission + identity events contract

**Files:**
- Create: `src/application/contracts/session-events.ts`
- Create: `src/application/contracts/tool-events.ts`
- Create: `src/application/contracts/permission-events.ts`
- Create: `src/application/contracts/identity-events.ts`
- Modify: `src/application/contracts/index.ts` — add all new exports
- Modify: `src/extensions/session/index.ts` — emit contracted events
- Modify: `src/extensions/tools/index.ts` — emit contracted tool.executed
- Modify: `src/extensions/permission/index.ts` — emit contracted permission.required
- Modify: `src/extensions/identity/index.ts` — emit contracted identity.changed

- [ ] **Step 1: Create `session-events.ts`**

```typescript
import { z } from 'zod';
import { createCodec } from './shared/codec';

// ── session.created ───────────────────────────────────────────────────────────

export interface SessionCreatedV1 {
  id: string;
  title: string;
}

export const sessionCreatedCodec = createCodec<SessionCreatedV1>(
  z.object({
    id: z.string(),
    title: z.string(),
  }),
);

// ── turn.started ──────────────────────────────────────────────────────────────

export interface TurnStartedV1 {
  /** Deprecated: use EventEnvelope.sessionId instead */
  sessionId: string;
  turnId: string;
}

export const turnStartedCodec = createCodec<TurnStartedV1>(
  z.object({
    sessionId: z.string(),
    turnId: z.string(),
  }),
);

// ── turn.completed ────────────────────────────────────────────────────────────

export interface TurnCompletedV1 {
  sessionId: string;
  turnId: string;
  usage?: { input: number; output: number };
}

export const turnCompletedCodec = createCodec<TurnCompletedV1>(
  z.object({
    sessionId: z.string(),
    turnId: z.string(),
    usage: z.object({ input: z.number(), output: z.number() }).optional(),
  }),
);

// ── turn.failed ───────────────────────────────────────────────────────────────

export interface TurnFailedV1 {
  sessionId: string;
  turnId: string;
  stage: string;
  reason: string;
}

export const turnFailedCodec = createCodec<TurnFailedV1>(
  z.object({
    sessionId: z.string(),
    turnId: z.string(),
    stage: z.string(),
    reason: z.string(),
  }),
);
```

- [ ] **Step 2: Create `tool-events.ts`**

```typescript
import { z } from 'zod';
import { createCodec } from './shared/codec';

// ── tool.executed ─────────────────────────────────────────────────────────────

export interface ToolExecutedV1 {
  name: string;
  duration: number;
  isError: boolean;
}

export const toolExecutedCodec = createCodec<ToolExecutedV1>(
  z.object({
    name: z.string(),
    duration: z.number(),
    isError: z.boolean(),
  }),
);
```

- [ ] **Step 3: Create `permission-events.ts`**

```typescript
import { z } from 'zod';
import { createCodec } from './shared/codec';

// ── permission.required ───────────────────────────────────────────────────────

export interface PermissionRequiredV1 {
  reqId: string;
  toolName: string;
  sessionId: string;
}

export const permissionRequiredCodec = createCodec<PermissionRequiredV1>(
  z.object({
    reqId: z.string(),
    toolName: z.string(),
    sessionId: z.string(),
  }),
);
```

- [ ] **Step 4: Create `identity-events.ts`**

```typescript
import { z } from 'zod';
import { createCodec } from './shared/codec';

// ── identity.changed ──────────────────────────────────────────────────────────
// payload is the identity diff object returned by IdentityStore

export interface IdentityChangedV1 {
  changes: Record<string, unknown>;
  version: number;
}

export const identityChangedCodec = createCodec<IdentityChangedV1>(
  z.object({
    changes: z.record(z.unknown()),
    version: z.number(),
  }),
);
```

- [ ] **Step 5: Update contracts `index.ts`**

Add:
```typescript
// Session events
export type { SessionCreatedV1, TurnStartedV1, TurnCompletedV1, TurnFailedV1 } from './session-events';
export { sessionCreatedCodec, turnStartedCodec, turnCompletedCodec, turnFailedCodec } from './session-events';

// Tool events
export type { ToolExecutedV1 } from './tool-events';
export { toolExecutedCodec } from './tool-events';

// Permission events
export type { PermissionRequiredV1 } from './permission-events';
export { permissionRequiredCodec } from './permission-events';

// Identity events
export type { IdentityChangedV1 } from './identity-events';
export { identityChangedCodec } from './identity-events';
```

- [ ] **Step 6: Modify `src/extensions/session/index.ts`**

Add import:
```typescript
import { createEvent } from '../../application/contracts';
```

Change `session.created` emit (line 110):
```typescript
// OLD:
ctx.bus.emit('session.created', session)

// NEW (minimal payload — Session object may contain non-serializable fields):
ctx.bus.emit('session.created', createEvent('session.created', {
  id: session.id,
  title: session.title,
}));
```

Change `turn.started` emit (line 132):
```typescript
// OLD:
ctx.bus.emit('turn.started', { sessionId, turnId: turn.id })

// NEW:
ctx.bus.emit('turn.started', createEvent('turn.started', {
  sessionId,
  turnId: turn.id,
}, { sessionId, turnId: turn.id }));
```

Change `turn.completed` emit (line 156):
```typescript
// OLD:
ctx.bus.emit('turn.completed', result)

// NEW (result = { sessionId, turnId, usage? }):
ctx.bus.emit('turn.completed', createEvent('turn.completed', {
  sessionId: result.sessionId,
  turnId: result.turnId,
  usage: result.usage,
}, { sessionId: result.sessionId, turnId: result.turnId }));
```

- [ ] **Step 7a: Modify `src/application/usecases/run-turn.ts`** — contract `turn.failed`

Add import:
```typescript
import { createEvent } from '../contracts';
```

Update `emitFailed` helper (around line 61-71):
```typescript
// OLD:
function emitFailed(...): void {
  bus.emit('turn.failed', {
    type: 'turn.failed', sessionId, turnId, stage, err: { message: err.message },
  })
}

// NEW:
function emitFailed(...): void {
  bus.emit('turn.failed', createEvent('turn.failed', {
    sessionId,
    turnId,
    stage,
    reason: err.message,
  }, { sessionId, turnId }));
}
```

- [ ] **Step 7b: Modify `src/extensions/tools/index.ts`**

Find the `tool.executed` emit (around line 262). Add import:
```typescript
import { createEvent } from '../../application/contracts';
```

Wrap emit:
```typescript
// OLD:
await ctx.bus.emit('tool.executed', {
  name: call.name,
  duration,
  isError: result.isError ?? false,
  ...
})

// NEW:
await ctx.bus.emit('tool.executed', createEvent('tool.executed', {
  name: call.name,
  duration,
  isError: result.isError ?? false,
}));
```

- [ ] **Step 8: Modify `src/extensions/permission/index.ts`**

Find the `permission.required` emit (around line 92). Add import:
```typescript
import { createEvent } from '../../application/contracts';
```

Wrap emit:
```typescript
// OLD:
await ctx.bus.emit('permission.required', { reqId, toolName: call.name, sessionId, ... })

// NEW:
await ctx.bus.emit('permission.required', createEvent('permission.required', {
  reqId,
  toolName: call.name,
  sessionId,
}));
```

- [ ] **Step 9: Modify `src/extensions/identity/index.ts`**

Find `identity.changed` emits (lines 50, 76, 89). Add import:
```typescript
import { createEvent } from '../../application/contracts';
```

Wrap each emit. The `diff` object from IdentityStore needs to be mapped. Check the actual shape of `IdentityStore.diff`:
```bash
grep -n "interface\|type\|class" src/extensions/identity/store.ts | head -20
```

Map the diff to `{ changes, version }`:
```typescript
// OLD:
ctx.bus.emit('identity.changed', diff)

// NEW:
ctx.bus.emit('identity.changed', createEvent('identity.changed', {
  changes: (diff as any).changes ?? {},
  version: (diff as any).version ?? 0,
}));
```

- [ ] **Step 10: Run type check**

```bash
bun run check:guard
```
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add src/application/contracts/session-events.ts src/application/contracts/tool-events.ts src/application/contracts/permission-events.ts src/application/contracts/identity-events.ts src/application/contracts/index.ts src/extensions/session/index.ts src/extensions/tools/index.ts src/extensions/permission/index.ts src/extensions/identity/index.ts
git commit -m "feat(p5): contract session, tool, permission, identity events"
```

---

### Task 8: History record versioning + type unification

**Files:**
- Create: `src/application/contracts/history-record.ts`
- Modify: `src/application/contracts/index.ts` — add history-record exports
- Modify: `src/extensions/session/index.ts` — write v1 records, fail-soft reader
- Modify: `src/application/usecases/append-history.ts` — import HistoryRecordV1, remove duplicate HistoryEntry
- Modify: `src/application/usecases/run-turn.ts` — use HistoryRecordV1 in MessageStorePort

- [ ] **Step 1: Create `history-record.ts`**

```typescript
import { z } from 'zod';
import { createCodec } from './shared/codec';

/**
 * HistoryRecordV1 — versioned session persistence format.
 * Unifies the three previously-duplicate types:
 *   - HistoryMessage (extensions/session/index.ts)
 *   - HistoryEntry  (application/usecases/append-history.ts)
 *   - MessageStorePort inline (application/usecases/run-turn.ts)
 */
export interface HistoryRecordV1 {
  kind: 'history.record';
  version: 1;
  sessionId: string;
  turnId?: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content?: string;
  blocks?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  id?: string;
  tool_call_id?: string;
  name?: string;
  ts: number;
  metadata?: Record<string, unknown>;
}

export const historyRecordCodec = createCodec<HistoryRecordV1>(
  z.object({
    kind: z.literal('history.record'),
    version: z.literal(1),
    sessionId: z.string(),
    turnId: z.string().optional(),
    role: z.enum(['user', 'assistant', 'tool', 'system']),
    content: z.string().optional(),
    blocks: z.array(z.object({
      type: z.string(),
      text: z.string().optional(),
      id: z.string().optional(),
      name: z.string().optional(),
      input: z.unknown().optional(),
    })).optional(),
    id: z.string().optional(),
    tool_call_id: z.string().optional(),
    name: z.string().optional(),
    ts: z.number(),
    metadata: z.record(z.unknown()).optional(),
  }),
);

/**
 * Parse a raw NDJSON line into a HistoryRecordV1 or null.
 * Old format (no kind/version): returns null — caller should skip + warn.
 * Unknown future version: returns null — INV-Data-4 fail-soft.
 */
export function parseHistoryLine(line: string): HistoryRecordV1 | null {
  try {
    const raw = JSON.parse(line);
    // Old format detection: no kind field
    if (!raw || typeof raw !== 'object' || !('kind' in raw)) {
      return null; // legacy format, skip
    }
    // Unknown version
    if (raw.version !== 1) {
      return null; // future version, fail-soft
    }
    const result = historyRecordCodec.safeDecode(raw);
    return result.ok ? result.value : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Update contracts `index.ts`**

Add:
```typescript
// History
export type { HistoryRecordV1 } from './history-record';
export { historyRecordCodec, parseHistoryLine } from './history-record';
```

- [ ] **Step 3: Modify `src/extensions/session/index.ts`**

Remove the local `HistoryMessage` interface (delete lines 15-22). Add import:
```typescript
import { createEvent, parseHistoryLine } from '../../application/contracts';
import type { HistoryRecordV1 } from '../../application/contracts';
```

Replace all `HistoryMessage[]` references with `HistoryRecordV1[]`:
- Line 57: `const messageHistory = new Map<string, HistoryRecordV1[]>()`
- Line 87: `async function appendNdjson(sid: string, msgs: HistoryRecordV1[])`

Update `restoreFromDisk` reader to use fail-soft parse (line 75):
```typescript
// OLD:
const messages: HistoryMessage[] = raw.trim().split('\n').map(line => JSON.parse(line))

// NEW:
const lines = raw.trim().split('\n').filter(l => l.length > 0);
const messages: HistoryRecordV1[] = [];
for (const line of lines) {
  const record = parseHistoryLine(line);
  if (record) {
    messages.push(record);
  }
  // old format or unknown version → skip + continue (INV-Data-4 fail-soft)
}
```

Update writer `appendNdjson` to write v1 records (line 91):
```typescript
// OLD:
const lines = msgs.map(m => JSON.stringify(m)).join('\n') + '\n'

// NEW:
const lines = msgs.map(m => JSON.stringify(m)).join('\n') + '\n'
// (HistoryRecordV1 object already has kind/version/ts — just stringify)
```

- [ ] **Step 4: Modify `src/application/usecases/append-history.ts`**

Remove the local `HistoryEntry` interface (lines 5-12). Import from contracts:
```typescript
import type { HistoryRecordV1 } from '../contracts';
```

Update function return type and internal usage:
```typescript
// OLD:
export function appendHistory(args: { ... }): HistoryEntry[]

// NEW:
export function appendHistory(args: {
  sessionId: string;
  turnId?: string;
  userInput: string;
  toolCalls: ReadonlyArray<ToolCallRecord>;
  finalText: string;
}): HistoryRecordV1[]
```

Update record construction to include `kind`, `version`, `sessionId`, `ts`. Each `out.push(...)` needs these fields added. Example:
```typescript
// OLD:
out.push({ role: 'user', content: args.userInput, id: nextId() })

// NEW:
out.push({
  kind: 'history.record',
  version: 1,
  sessionId: args.sessionId,
  turnId: args.turnId,
  role: 'user',
  content: args.userInput,
  id: nextId(),
  ts: Date.now(),
});
```

Apply same transformation to all 4-5 push sites in the function.

- [ ] **Step 5: Modify `src/application/usecases/run-turn.ts`**

Update `MessageStorePort` to use `HistoryRecordV1`:
```typescript
import type { HistoryRecordV1 } from '../contracts';

export interface MessageStorePort {
  get(sessionId: string): HistoryRecordV1[];
  appendBatch(sessionId: string, msgs: HistoryRecordV1[]): Promise<void>;
}
```

- [ ] **Step 6: Run type check**

```bash
bun run check:guard
```
Expected: PASS (may need to fix callers of appendHistory / MessageStorePort)

- [ ] **Step 7: Run tests**

```bash
bun test
```
Expected: session-related tests may need updates. Fix any test failures before proceeding.

- [ ] **Step 8: Commit**

```bash
git add src/application/contracts/history-record.ts src/application/contracts/index.ts src/extensions/session/index.ts src/application/usecases/append-history.ts src/application/usecases/run-turn.ts
git commit -m "feat(p5): version session history record, unify duplicate history types"
```

---

### Task 9: Architecture guards

**Files:**
- Modify: `eslint.config.js` — add contracts import guards
- Modify: `scripts/check-architecture.ts` — add data ownership guards

- [ ] **Step 1: Add ESLint rules for ports/frontend isolation**

In `eslint.config.js`, add a new override section after the existing `no-restricted-imports` block (around line 100). Insert before the test files override:

```javascript
// ===== INV-Data-1/2: ports and frontend must not import extensions =====
{
  files: ['src/application/ports/**', 'src/core/frontend/**'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [{
        group: ['**/extensions/**'],
        message:
          'ports/frontend must not import extensions/** (INV-Data-1/2). ' +
          'Import from application/contracts/** instead.',
      }],
    }],
  },
},

// ===== INV-Data-7: transport adapters must only depend on ports/contracts =====
{
  files: ['src/infrastructure/transport/**'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [{
        group: ['**/extensions/**'],
        message:
          'Transport adapters must not import extensions/** (INV-Data-7). ' +
          'Import from application/contracts/** instead.',
      }],
    }],
  },
},

// ===== zod boundary: only application/contracts may import zod =====
{
  files: ['src/**'],
  excludedFiles: ['src/application/contracts/**'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [{
        group: ['zod'],
        message:
          'zod is restricted to application/contracts/**. ' +
          'Use application/contracts codecs for runtime validation elsewhere.',
      }],
    }],
  },
},
```

- [ ] **Step 2: Add architecture script guards**

In `scripts/check-architecture.ts`, add new rules after the existing G1 rule (before the Output section):

```typescript
// ────────────────────────────────────────────
// Rule P5-1: DataPlaneEvent must not be defined in extensions/dataplane
// ────────────────────────────────────────────
for (const f of project.getSourceFiles('src/extensions/dataplane/**')) {
  const text = f.getFullText();
  if (text.includes('DataPlaneEvent') && text.includes('interface DataPlaneEvent')) {
    v(`[P5-1] ${f.getFilePath()} — DataPlaneEvent must be defined in application/contracts/, not extensions/dataplane/`);
  }
}

// ────────────────────────────────────────────
// Rule P5-2: No new public contract types in src/types.ts
// ────────────────────────────────────────────
const typesFile = project.getSourceFile('src/types.ts');
if (typesFile) {
  const typesText = typesFile.getFullText();
  // Count exported interfaces/types — baseline after ContentBlock removal
  const exportMatches = typesText.match(/export\s+(interface|type)\s+\w+/g) ?? [];
  const allowedTypes = new Set([
    'TodoStatus', 'TodoItem', 'ToolContext', 'ToolSink', 'createToolSink',
    'Message', 'Tool', 'ToolImplementation', 'ToolCall',
    'LLMResponse', 'LLMResponseChunk', 'CompressionStrategy',
    'AgentConfig', 'AgentContext', 'Provider', 'Middleware',
    'AgentHooks', 'AgentMiddleware', 'flattenBlocks',
    'synthesizeBlocksFromLegacy', 'TypedMetadataKey',
    'defineMetadataKey', 'getMetadata', 'setMetadata', 'Session',
  ]);
  for (const match of exportMatches) {
    const name = match.replace('export ', '').replace('interface ', '').replace('type ', '');
    if (!allowedTypes.has(name)) {
      v(`[P5-2] src/types.ts — new exported type '${name}' detected. New public contracts must go in application/contracts/`);
    }
  }
}
```

- [ ] **Step 3: Verify guards catch violations**

```bash
# Verify eslint catches port→extension import
echo "import { foo } from '../extensions/dataplane/event-types'" > /tmp/test-guard.ts
# (Manual check: CI/check:arch should pass on clean codebase)

bun run check:arch
```
Expected: PASS (all new rules pass on clean codebase)

- [ ] **Step 4: Commit**

```bash
git add eslint.config.js scripts/check-architecture.ts
git commit -m "feat(p5): add architecture guards for contract ownership isolation"
```

---

### Task 10: Final integration verification

**Files:** (none, verification only)

- [ ] **Step 1: Run full CI check**

```bash
bun run check:all
```
Expected: All checks PASS (typecheck + tests + architecture)

- [ ] **Step 2: Verify all TODO(p-4) are resolved**

```bash
grep -rn "TODO(p-4)" src/
```
Expected: No remaining TODO(p-4) in ports/, core/frontend/, infrastructure/transport/

- [ ] **Step 3: Verify no source files import from deleted paths**

```bash
grep -rn "extensions/dataplane/event-types" src/ tests/ && echo "FAIL" || echo "PASS"
grep -rn "extensions/controlplane/jsonrpc" src/ tests/ && echo "FAIL" || echo "PASS"
```
Expected: PASS for both

- [ ] **Step 4: Verify contract ownership**

```bash
# ports/ must not import extensions/**
grep -rn "from '.*extensions/" src/application/ports/ && echo "FAIL" || echo "PASS"
# core/frontend/ must not import extensions/**
grep -rn "from '.*extensions/" src/core/frontend/ && echo "FAIL" || echo "PASS"
# transport/ must not import extensions/**
grep -rn "from '.*extensions/" src/infrastructure/transport/ && echo "FAIL" || echo "PASS"
```
Expected: PASS for all

- [ ] **Step 5: Notify completion**

P-5 implementation complete. Ready for code review.
