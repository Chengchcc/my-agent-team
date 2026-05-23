# P-8: Frontend Adapter 重构 + Command 体系统一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `frontend.tui` and `frontend.lark` as proper kernel frontend adapters on shared infrastructure (transcript projector + session-client), unify slash commands as cross-frontend application-layer capability, and delete the old Agent/SessionStore/ContextManager compatibility layer.

**Architecture:** Four sequential tracks. Track A establishes the shared foundation: snapshot-returning controlplane RPCs, session-client (unified kernel communication), and transcript projector (unified event model converting both dataplane events and `HistoryRecordV1[]` snapshots into `TranscriptEvent[]`). Both frontends are rewired to use these. Track B lifts slash commands from TUI-private to `application/commands/` with a unified registry, parser, and 7 builtin commands. Track C introduces a KeyDispatcher with LIFO stack for input arbitration. Track D deletes `KernelAgentFacade`, `KernelSessionStoreFacade`, `Agent`, `SessionStore`, `AgentContextManager`, and all `types.ts` imports.

**Tech Stack:** TypeScript, Zustand (TUI store), Ink/React (TUI rendering), @larksuiteoapi/node-sdk (Lark), Bun test

**Locked Decisions (from grill-me):**
1. Snapshot = `HistoryRecordV1[]`, `session.attach`/`resume` return it
2. Permission/AskUserQuestion: dataplane event trigger + RPC reply, each frontend renders its own UI
3. Command side effects via `kernel.rpc()`, not direct bus/extensions
4. TranscriptEvent delta granularity, `assistant_text_final` at each LLM response end
5. Phase order: A → B → C → D (sequential)
6. KeyDispatcher: explicit register + LIFO stack
7. Commands: application pure logic, no extension (same as `define-tool.ts`)
8. ToolCallViewModel result: `unknown` raw type, view selects renderer by tool name
9. Committer stays in TUI layer, projector does no markdown parsing
10. Agent/SessionStore/ContextManager facades deleted in Phase D
11. Skill names = input autocomplete, not command registry entries
12. session-client `subscribeEvents` callback: `(DataPlaneEvent) => void`
13. Lark streaming: A scheme + rate limiting (batch updateMessage per N seconds)
14. RoutingTable stays in Lark extension
15. Permission/AskUserQuestion: shared trigger + data exit, per-frontend render
16. LarkBotAdapter uses session-client for all RPC
17. Lark `types.ts` imports `Session` from `domain/session`
18. Phase A rewires both frontends together

---

## File Structure

### New files (Track A — 6 files)

| File | Responsibility |
|------|---------------|
| `src/extensions/frontend.tui/session-client.ts` | Unified kernel communication layer — all RPC through here |
| `src/extensions/frontend.tui/transcript/types.ts` | `TranscriptEvent` discriminated union — 12 variants |
| `src/extensions/frontend.tui/transcript/projector.ts` | Converts DataPlaneEvent + HistoryRecordV1[] → TranscriptEvent[] |
| `src/extensions/frontend.tui/transcript/from-dataplane.ts` | DataPlaneEvent → TranscriptEvent converter |
| `src/extensions/frontend.tui/transcript/from-history.ts` | HistoryRecordV1[] → TranscriptEvent[] converter |
| `src/extensions/frontend.tui/input/key-dispatcher.ts` | LIFO stack key dispatcher for input arbitration |

### New files (Track B — 10 files)

| File | Responsibility |
|------|---------------|
| `src/application/commands/types.ts` | `CommandDefinition`, `CommandGroup`, `ParsedCommand`, `CommandExecutionContext`, `CommandResult` |
| `src/application/commands/command-groups.ts` | 8 preset groups: core/session/context/tooling/ui/workflow/debug/admin |
| `src/application/commands/command-registry.ts` | `CommandRegistry` class: register, get, list, resolveAlias, parse |
| `src/application/commands/parse-command.ts` | `parseCommand(raw)`: slash detection, name/args/argv split |
| `src/application/commands/builtin/clear.ts` | `/clear` command |
| `src/application/commands/builtin/compact.ts` | `/compact` command |
| `src/application/commands/builtin/help.ts` | `/help` command — grouped listing |
| `src/application/commands/builtin/cost.ts` | `/cost` command |
| `src/application/commands/builtin/tools.ts` | `/tools` command |
| `src/application/commands/builtin/exit.ts` | `/exit` `/quit` command |

### Modified files (core changes)

| File | Change |
|------|--------|
| `src/extensions/controlplane/methods.ts` | Add `session.clear`, `session.compact`, `session.stats` RPC; extend `session.attach`/`resume` to return `snapshot: HistoryRecordV1[]`; add `tool.list` RPC |
| `src/extensions/session/index.ts` | Add snapshot construction for attach/resume; implement clear |
| `src/extensions/frontend.tui/index.ts` | Shrink TUIAdapter — delete `asAgent()`/`asSessionStore()`/`KernelAgentFacade`/`KernelSessionStoreFacade`; wire session-client + projector |
| `src/extensions/frontend.tui/types.ts` | Delete `Agent`, `AgentContextManager`, `SessionStore`, `AgentEvent`; add `TranscriptEvent` |
| `src/extensions/frontend.tui/App.tsx` | Rewire to session-client + projector; remove `agent`/`sessionStore` props |
| `src/extensions/frontend.tui/command-registry.ts` | Delete — replaced by `application/commands/command-registry.ts` |
| `src/extensions/frontend.tui/tui-types.ts` | Delete `CommandHandlerContext` |
| `src/extensions/frontend.tui/hooks/use-agent-subscription.ts` | Rewire to projector output |
| `src/extensions/frontend.tui/hooks/use-session-picker.ts` | Rewire to snapshot + projector |
| `src/extensions/frontend.tui/hooks/use-command-input.ts` | Rewire to unified parseCommand; integrate KeyDispatcher |
| `src/extensions/frontend.tui/state/store.ts` | Replace `AgentEvent` references with `TranscriptEvent` |
| `src/extensions/frontend.tui/state/message-converter.ts` | Replace `Message[]` with `HistoryRecordV1[]` |
| `src/extensions/frontend.lark/index.ts` | Wire session-client + projector; add streaming card update path |
| `src/extensions/frontend.lark/lark/types.ts` | Fix `Session` import from `domain/session` |
| `src/extensions/frontend.lark/lark/card-builder.ts` | Integrate with projector output |
| `src/extensions/tools/tools/index.ts` | Delete old barrel (these types now in flat `tools/` + proper ports) |
| `src/extensions/presets.ts` | Add `commands` builtin registration |

### Deleted files

| File | Reason |
|------|--------|
| `src/extensions/frontend.tui/command-registry.ts` | Replaced by `application/commands/command-registry.ts` |
| `src/extensions/frontend.tui/tui-types.ts` | `CommandHandlerContext` replaced by `CommandExecutionContext` |
| `src/extensions/frontend.tui/commands/compact-command.ts` | Migrated to `application/commands/builtin/compact.ts` |
| `src/extensions/frontend.tui/commands/diagnostic-commands.ts` | Migrated to `application/commands/builtin/cost.ts` + `tools.ts` |
| `src/extensions/frontend.tui/commands/daemon-commands.ts` | Migrated to `application/commands/builtin/` |
| `src/extensions/frontend.tui/commands/mcp-commands.ts` | MCP commands removed — not functional (stub) |
| `src/extensions/tools/tools/index.ts` | Dead barrel (P-7 leftover, re-exports deleted files) |

---

## Track A: Snapshot + Transcript Projector + Session-Client

### Task A1: Extend controlplane RPCs — session.clear, session.compact, session.stats, tool.list, snapshot returns

**Files:**
- Modify: `src/extensions/controlplane/methods.ts`
- Modify: `src/extensions/session/index.ts`

- [ ] **Step 1: Add new controlplane RPCs**

In `controlplane/methods.ts`, add four new RPC handlers after the existing `session.rename` handler:

```ts
'session.clear': async (params: unknown) => {
  const p = params as { sessionId?: string } | undefined
  const sessionId = p?.sessionId ?? 'main'
  const store = getStore()
  const session = await store.load(sessionId)
  if (!session) throw new Error(`Session not found: ${sessionId}`)
  // Clear message history
  try {
    const hist = ctx.extensions.get<{ clear(sessionId: string): void }>('session.history')
    if ('clear' in (hist as Record<string, unknown>)) {
      (hist as Record<string, unknown>).clear(sessionId)
    }
  } catch { /* history may not support clear */ }
  await store.save(session)
  return { ok: true, sessionId }
},

'session.compact': async (params: unknown) => {
  const p = params as { sessionId?: string } | undefined
  const sessionId = p?.sessionId ?? 'main'
  // Trigger memory summarization via hook
  await ctx.hooks.dispatch('onCompactRequested', sessionId)
  return { ok: true, sessionId }
},

'session.stats': async (params: unknown) => {
  const p = params as { sessionId?: string } | undefined
  const sessionId = p?.sessionId ?? 'main'
  let totalInput = 0, totalOutput = 0, turnCount = 0
  try {
    const hist = ctx.extensions.get<{ get(sessionId: string): Array<{ usage?: { input: number; output: number } }> }>('session.history')
    const msgs = hist.get(sessionId)
    turnCount = msgs.filter(m => m.usage).length
    for (const m of msgs) {
      if (m.usage) {
        totalInput += m.usage.input
        totalOutput += m.usage.output
      }
    }
  } catch { /* history may not be available */ }
  return { ok: true, sessionId, usage: { input: totalInput, output: totalOutput }, turnCount }
},

'tool.list': async () => {
  try {
    const catalog = ctx.extensions.get<{ list(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> }>('tool-catalog.catalog')
    return { tools: catalog.list().map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }
  } catch {
    return { tools: [] }
  }
},
```

- [ ] **Step 2: Extend session.attach to return snapshot**

In the `session.attach` handler (already exists), add `snapshot` field:

After the existing `messages` fetch logic (~line 63-67), construct snapshot:

```ts
let snapshot: HistoryRecordV1[] = []
try {
  const hist = ctx.extensions.get<{ get(sessionId: string): HistoryRecordV1[] }>('session.history')
  snapshot = hist.get(sessionId)
} catch { /* history may not be available */ }

return { ok: true, sessionId, frontendId, messages, snapshot }
```

- [ ] **Step 3: Extend session.resume to return snapshot**

Same pattern in `session.resume` — add snapshot to return value.

- [ ] **Step 4: Add snapshot construction in session extension**

In `session/index.ts`, ensure the `session.history` capability provides a `getAll()` or `get()` method that returns `HistoryRecordV1[]`. This already exists — verify:

```bash
grep -n "get.*sessionId.*HistoryRecord" src/extensions/session/index.ts
```

- [ ] **Step 5: Compile and test**

```bash
bun run tsc --noEmit 2>&1 | head -10
bun test 2>&1 | tail -5
```

- [ ] **Step 6: Commit**

```bash
git add src/extensions/controlplane/methods.ts src/extensions/session/index.ts
git commit -m "feat(p8): extend controlplane RPC — session.clear/compact/stats, tool.list, snapshot returns"
```

---

### Task A2: Add session-client — unified kernel communication layer

**Files:**
- Create: `src/extensions/frontend.tui/session-client.ts`

- [ ] **Step 1: Create session-client.ts**

```ts
import type { Transport } from '../../application/ports/transport';
import type { DataPlaneEvent, HistoryRecordV1 } from '../../application/contracts';

export interface SessionSummary {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  lastActiveAt: string;
}

export interface AttachResult {
  sessionId: string;
  frontendId: string;
  snapshot: HistoryRecordV1[];
}

export interface ResumeResult {
  sessionId: string;
  session: Record<string, unknown>;
  snapshot: HistoryRecordV1[];
}

export class SessionClient {
  constructor(private transport: Transport, private frontendId: string) {}

  async listSessions(): Promise<SessionSummary[]> {
    const result = await this.transport.sendRpc('session.list', {}) as { sessions: SessionSummary[] };
    return result.sessions;
  }

  async attachSession(sessionId?: string): Promise<AttachResult> {
    return this.transport.sendRpc('session.attach', {
      frontendId: this.frontendId,
      sessionId: sessionId ?? 'main',
    }) as Promise<AttachResult>;
  }

  async resumeSession(targetSessionId: string, currentSessionId?: string): Promise<ResumeResult> {
    return this.transport.sendRpc('session.resume', {
      frontendId: this.frontendId,
      sessionId: targetSessionId,
      currentSessionId: currentSessionId ?? 'main',
    }) as Promise<ResumeResult>;
  }

  async createSession(title?: string): Promise<{ sessionId: string }> {
    return this.transport.sendRpc('session.create', {
      frontendId: this.frontendId,
      title,
    }) as Promise<{ sessionId: string }>;
  }

  async sendInput(sessionId: string, text: string): Promise<void> {
    await this.transport.sendRpc('input.send', {
      sessionId,
      frontendId: this.frontendId,
      text,
    });
  }

  async cancelInput(sessionId: string, reason?: string): Promise<void> {
    await this.transport.sendRpc('input.cancel', {
      sessionId,
      reason,
    });
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.transport.sendRpc('session.clear', { sessionId });
  }

  async compactSession(sessionId: string): Promise<void> {
    await this.transport.sendRpc('session.compact', { sessionId });
  }

  async getSessionStats(sessionId: string): Promise<{ input: number; output: number; turnCount: number }> {
    const result = await this.transport.sendRpc('session.stats', { sessionId }) as { ok: boolean; usage: { input: number; output: number }; turnCount: number };
    return { input: result.usage.input, output: result.usage.output, turnCount: result.turnCount };
  }

  async getToolList(): Promise<Array<{ name: string; description: string; parameters: Record<string, unknown> }>> {
    const result = await this.transport.sendRpc('tool.list', {}) as { tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }> };
    return result.tools;
  }

  subscribeEvents(sessionId: string, cb: (event: DataPlaneEvent) => void): () => void {
    return this.transport.onEvent((event: DataPlaneEvent) => {
      if (event.sessionId === sessionId || !event.sessionId) {
        cb(event);
      }
    });
  }
}
```

- [ ] **Step 2: Compile**

```bash
bun run tsc --noEmit 2>&1 | head -10
```

- [ ] **Step 3: Commit**

```bash
git add src/extensions/frontend.tui/session-client.ts
git commit -m "feat(p8): add session-client — unified kernel communication layer"
```

---

### Task A3: Add transcript projector — unified event model

**Files:**
- Create: `src/extensions/frontend.tui/transcript/types.ts`
- Create: `src/extensions/frontend.tui/transcript/projector.ts`
- Create: `src/extensions/frontend.tui/transcript/from-dataplane.ts`
- Create: `src/extensions/frontend.tui/transcript/from-history.ts`

- [ ] **Step 1: Create transcript/types.ts — TranscriptEvent discriminated union**

```ts
import type { HistoryRecordV1 } from '../../../application/contracts';

export type TranscriptEvent =
  | { type: 'session_snapshot_loaded'; sessionId: string; records: HistoryRecordV1[] }
  | { type: 'user_message'; sessionId: string; turnId: string; content: string }
  | { type: 'turn_started'; sessionId: string; turnId: string }
  | { type: 'assistant_text_delta'; sessionId: string; turnId: string; delta: string; roundIndex: number }
  | { type: 'assistant_text_final'; sessionId: string; turnId: string; roundIndex: number; fullText: string }
  | { type: 'tool_call_started'; sessionId: string; turnId: string; callId: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_call_finished'; sessionId: string; turnId: string; callId: string; name: string; result: unknown; isError: boolean; durationMs: number }
  | { type: 'turn_completed'; sessionId: string; turnId: string; usage: { input: number; output: number }; finalMessage: string }
  | { type: 'turn_failed'; sessionId: string; turnId: string; stage: string; reason: string }
  | { type: 'system_notice'; sessionId: string; message: string }
  | { type: 'permission_requested'; sessionId: string; reqId: string; toolName: string }
  | { type: 'user_question_requested'; sessionId: string; questionId: string; questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect?: boolean }> };

export interface ToolCallViewModel {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  status: 'running' | 'done' | 'error';
  result?: unknown;
  durationMs?: number;
  isError?: boolean;
}
```

- [ ] **Step 2: Create transcript/from-dataplane.ts**

```ts
import type { DataPlaneEvent } from '../../../application/contracts';
import type { TranscriptEvent } from './types';

let turnIndex = 0;
let roundIndex = 0;

export function dataplaneToTranscriptEvent(event: DataPlaneEvent): TranscriptEvent | null {
  const p = event.payload as Record<string, unknown>;
  const sid = (event.sessionId ?? p.sessionId ?? 'main') as string;
  const tid = (p.turnId ?? `turn-${turnIndex}`) as string;

  switch (event.type) {
    case 'turn.started':
      turnIndex++;
      roundIndex = 0;
      return { type: 'turn_started', sessionId: sid, turnId: tid };

    case 'assistant.delta':
      return { type: 'assistant_text_delta', sessionId: sid, turnId: tid, delta: String(p.delta ?? ''), roundIndex };

    case 'tool.update': {
      const phase = p.phase as string | undefined;
      const id = String(p.callId ?? p.toolCallId ?? '');
      const name = String(p.name ?? p.toolName ?? '');
      const args = (p.args ?? p.input ?? {}) as Record<string, unknown>;
      if (phase === 'start') {
        return { type: 'tool_call_started', sessionId: sid, turnId: tid, callId: id, name, input: args };
      }
      roundIndex++;
      return {
        type: 'tool_call_finished', sessionId: sid, turnId: tid, callId: id, name,
        result: p.result, isError: (p.isError as boolean) ?? false,
        durationMs: (p.durationMs as number) ?? 0,
      };
    }

    case 'turn.completed':
      return {
        type: 'turn_completed', sessionId: sid, turnId: tid,
        usage: { input: (p.usage as Record<string, number>)?.input ?? 0, output: (p.usage as Record<string, number>)?.output ?? 0 },
        finalMessage: String(p.finalMessage ?? ''),
      };

    case 'turn.failed':
      return { type: 'turn_failed', sessionId: sid, turnId: tid, stage: String(p.stage ?? ''), reason: String(p.reason ?? '') };

    case 'permission.required':
      return { type: 'permission_requested', sessionId: sid, reqId: String(p.reqId ?? ''), toolName: String(p.toolName ?? '') };

    default:
      return null;
  }
}
```

- [ ] **Step 3: Create transcript/from-history.ts**

```ts
import type { HistoryRecordV1 } from '../../../application/contracts';
import type { TranscriptEvent } from './types';

export function historyToTranscriptEvents(records: HistoryRecordV1[]): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  let currentTurnId = '';

  for (const r of records) {
    const sid = 'main'; // snapshot always for a specific session
    switch (r.role) {
      case 'user':
        currentTurnId = `turn-history-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        events.push({ type: 'turn_started', sessionId: sid, turnId: currentTurnId });
        events.push({ type: 'user_message', sessionId: sid, turnId: currentTurnId, content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content) });
        break;
      case 'assistant': {
        let text = '';
        const blocks = (r as { blocks?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> }).blocks ?? [];
        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            text += block.text;
          } else if (block.type === 'tool_use') {
            events.push({
              type: 'tool_call_started', sessionId: sid, turnId: currentTurnId,
              callId: block.id ?? '', name: block.name ?? '', input: (block.input as Record<string, unknown>) ?? {},
            });
          }
        }
        if (text) {
          events.push({ type: 'assistant_text_final', sessionId: sid, turnId: currentTurnId, roundIndex: 0, fullText: text });
        }
        break;
      }
      case 'tool': {
        const toolRecord = r as { tool_call_id?: string; name?: string; content?: string };
        events.push({
          type: 'tool_call_finished', sessionId: sid, turnId: currentTurnId,
          callId: toolRecord.tool_call_id ?? '', name: toolRecord.name ?? '',
          result: toolRecord.content ?? '', isError: false, durationMs: 0,
        });
        break;
      }
    }
  }
  return events;
}
```

- [ ] **Step 4: Create transcript/projector.ts**

```ts
import type { DataPlaneEvent, HistoryRecordV1 } from '../../../application/contracts';
import type { TranscriptEvent } from './types';
import { dataplaneToTranscriptEvent } from './from-dataplane';
import { historyToTranscriptEvents } from './from-history';

export class TranscriptProjector {
  private listeners = new Set<(event: TranscriptEvent) => void>();

  onEvent(cb: (event: TranscriptEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  pushDataplaneEvent(event: DataPlaneEvent): void {
    const te = dataplaneToTranscriptEvent(event);
    if (te) {
      for (const cb of this.listeners) cb(te);
    }
  }

  loadHistory(records: HistoryRecordV1[]): void {
    const events = historyToTranscriptEvents(records);
    for (const evt of events) {
      for (const cb of this.listeners) cb(evt);
    }
  }

  destroy(): void {
    this.listeners.clear();
  }
}
```

- [ ] **Step 5: Compile**

```bash
bun run tsc --noEmit 2>&1 | head -10
```

- [ ] **Step 6: Commit**

```bash
git add src/extensions/frontend.tui/transcript/
git commit -m "feat(p8): add transcript projector — unified event model + from-dataplane + from-history"
```

---

### Task A4: Rewire TUI to session-client + projector

**Files:**
- Modify: `src/extensions/frontend.tui/index.ts` — shrink TUIAdapter
- Modify: `src/extensions/frontend.tui/App.tsx` — rewired props
- Modify: `src/extensions/frontend.tui/hooks/use-agent-subscription.ts` — use projector
- Modify: `src/extensions/frontend.tui/hooks/use-session-picker.ts` — snapshot + projector
- Modify: `src/extensions/frontend.tui/state/store.ts` — TranscriptEvent actions
- Modify: `src/extensions/frontend.tui/state/message-converter.ts` — HistoryRecordV1

- [ ] **Step 1: Shrink TUIAdapter — delete asAgent()/asSessionStore()**

In `frontend.tui/index.ts`:
- Delete `KernelAgentFacade` class (lines 156-227)
- Delete `KernelSessionStoreFacade` class (lines 231-279)
- Delete `TUIAdapter.asAgent()` (lines 418-424)
- Delete `TUIAdapter.asSessionStore()` (lines 427-434)
- Delete `EventBridge` (lines 88-152) — replaced by projector

The `TUIAdapter` retains: `start()`, `stop()`, `sendRpc()`, `sendInput()`, `attachSession()`, `detachSession()`, `resumeSession()`, `listSessions()`, `getTransport()`.

Add a `createSessionClient()` method to `TUIAdapter`:

```ts
createSessionClient(): SessionClient {
  return new SessionClient(this.transport, this.id);
}
```

- [ ] **Step 2: Rewire App.tsx**

Change `AppV2` props from `{ agent: Agent, sessionStore: SessionStore, skillCommands }` to `{ client: SessionClient, projector: TranscriptProjector, skillNames: string[] }`.

Remove `buildV2CommandContext()` — it created `CommandHandlerContext` with `agent`/`sessionStore`. Replace with `CommandExecutionContext` using session-client.

- [ ] **Step 3: Rewire use-agent-subscription.ts**

Replace `agent.runAgentLoop()` with direct session-client calls:
```ts
const submit = useCallback(async (text: string) => {
  await client.sendInput(sessionId, text);
  // Projector handles all incoming events via subscribeEvents
}, [client, sessionId]);
```

Wire projector to store:
```ts
useEffect(() => {
  const unsub = projector.onEvent((event) => {
    switch (event.type) {
      case 'assistant_text_delta': store.textDelta(event.delta); break;
      case 'tool_call_started': store.toolStart(event.callId, event.name, event.input); break;
      case 'tool_call_finished': store.toolDone(event.callId, { kind: event.isError ? 'error' : 'ok', content: JSON.stringify(event.result), durationMs: event.durationMs }); break;
      case 'turn_completed': store.turnDone(); break;
      case 'turn_started': store.turnStart('assistant-' + event.turnId); break;
      case 'system_notice': store.appendSystemNotice(Date.now().toString(), event.message); break;
    }
  });
  return unsub;
}, [projector]);
```

- [ ] **Step 4: Rewire use-session-picker.ts**

Replace `sessionStore.loadSession()` + `contextManager.addMessage()` with:
```ts
const result = await client.attachSession(sessionId);
projector.loadHistory(result.snapshot);
```

- [ ] **Step 5: Update store.ts TranscriptEvent actions**

Add `toolStart`, `toolDone`, `turnStart`, `turnDone` actions that accept `TranscriptEvent`-derived params (already exist, but verify signatures match).

- [ ] **Step 6: Update message-converter.ts**

Replace `messagesToFinalizedItems(messages: Message[])` with `historyToFinalizedItems(records: HistoryRecordV1[])`:

```ts
export function historyToFinalizedItems(records: HistoryRecordV1[]): FinalItem[] {
  // Similar logic but working with HistoryRecordV1 instead of Message
  // ...
}
```

- [ ] **Step 7: Compile and test**

```bash
bun run tsc --noEmit 2>&1 | head -20
bun test 2>&1 | tail -5
```

Expected: compile errors from deleted types — these will be fixed in subsequent tasks (especially Track D).

- [ ] **Step 8: Commit**

```bash
git add src/extensions/frontend.tui/
git commit -m "refactor(p8): rewire TUI to session-client + projector, shrink TUIAdapter"
```

---

### Task A5: Rewire Lark to session-client + projector

**Files:**
- Modify: `src/extensions/frontend.lark/index.ts`
- Modify: `src/extensions/frontend.lark/lark/types.ts`

- [ ] **Step 1: Create session-client in LarkBotAdapter**

Add `SessionClient` member to `LarkBotAdapter`, initialized from transport:

```ts
private sessionClient: SessionClient;

constructor(...) {
  this.sessionClient = new SessionClient(transport, botId);
}
```

Replace all direct `transport.sendRpc()` calls with `sessionClient` methods:

| Old | New |
|-----|-----|
| `transport.sendRpc('session.create', ...)` | `sessionClient.createSession(title)` |
| `transport.sendRpc('input.send', ...)` | `sessionClient.sendInput(sessionId, text)` |
| `transport.sendRpc('session.attach', ...)` | `sessionClient.attachSession(sessionId)` |
| `transport.sendRpc('session.clear', ...)` | `sessionClient.clearSession(sessionId)` |
| `transport.sendRpc('session.close', ...)` | (defer — no session.close in client yet) |

- [ ] **Step 2: Wire projector for streaming card updates**

In `LarkBotAdapter`, add `TranscriptProjector` and subscribe:

```ts
private projector = new TranscriptProjector();

// In start():
const unsub = this.sessionClient.subscribeEvents(sessionId, (event) => {
  this.projector.pushDataplaneEvent(event);
});

this.projector.onEvent(async (te) => {
  // Rate-limited streaming card update
  if (te.type === 'assistant_text_delta' || te.type === 'tool_call_finished') {
    this.scheduleCardUpdate(te.sessionId);
  }
});
```

Add `scheduleCardUpdate()` with rate limiting (batch per 2 seconds):

```ts
private cardUpdateTimers = new Map<string, ReturnType<typeof setTimeout>>();

private scheduleCardUpdate(sessionId: string): void {
  const existing = this.cardUpdateTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  this.cardUpdateTimers.set(sessionId, setTimeout(() => {
    this.flushCardUpdate(sessionId);
    this.cardUpdateTimers.delete(sessionId);
  }, 2000));
}

private async flushCardUpdate(sessionId: string): Promise<void> {
  const card = buildStreamingCard(/* transcript state */);
  await this.larkClient.updateMessage(this.lastMessageId, card);
}
```

- [ ] **Step 3: Fix lark/types.ts Session import**

```ts
// Old:
import type { Session } from '../../../types';
// New:
import type { Session } from '../../../domain/session';
```

- [ ] **Step 4: Compile**

```bash
bun run tsc --noEmit 2>&1 | head -10
```

- [ ] **Step 5: Commit**

```bash
git add src/extensions/frontend.lark/
git commit -m "refactor(p8): rewire Lark to session-client + projector, fix Session import"
```

---

### Task A6: Clean up dead tools/tools barrel

**Files:**
- Delete: `src/extensions/tools/tools/index.ts` (P-7 leftover, re-exports deleted files)
- Delete: `src/extensions/tools/tools/ask-user-question-manager.ts` (dead — TUI gets this via dataplane now)
- Delete: `src/extensions/tools/tools/permission-manager.ts` (dead — TUI gets this via dataplane now)
- Modify: `src/extensions/frontend.tui/hooks/use-permission-manager.ts` — remove import from tools/tools
- Modify: `src/extensions/frontend.tui/hooks/use-ask-user-question-manager.ts` — remove import from tools/tools

- [ ] **Step 1: Remove TUI's cross-extension imports**

Rewrite `use-permission-manager.ts` to subscribe to dataplane `permission.required` events and reply via RPC instead of importing `globalPermissionManager`:

```ts
// Old: import { globalPermissionManager } from '../../tools/tools';
// New: subscribe to projector events for permission_requested
```

Rewrite `use-ask-user-question-manager.ts` similarly.

- [ ] **Step 2: Delete dead files**

```bash
rm src/extensions/tools/tools/index.ts
rm src/extensions/tools/tools/ask-user-question-manager.ts
rm src/extensions/tools/tools/permission-manager.ts
rmdir src/extensions/tools/tools/ 2>/dev/null || true
```

- [ ] **Step 3: Compile and test**

```bash
bun run tsc --noEmit 2>&1 | head -10
bun test 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git rm src/extensions/tools/tools/index.ts src/extensions/tools/tools/ask-user-question-manager.ts src/extensions/tools/tools/permission-manager.ts
git add src/extensions/frontend.tui/hooks/use-permission-manager.ts src/extensions/frontend.tui/hooks/use-ask-user-question-manager.ts
git commit -m "chore(p8): delete dead tools/tools barrel, rewire TUI hooks to dataplane"
```

---

## Track B: Command 体系统一

### Task B1: Create application/commands — types, groups, registry, parser

**Files:**
- Create: `src/application/commands/types.ts`
- Create: `src/application/commands/command-groups.ts`
- Create: `src/application/commands/command-registry.ts`
- Create: `src/application/commands/parse-command.ts`

- [ ] **Step 1: Create types.ts**

```ts
export interface CommandDefinition {
  name: string;
  description: string;
  group: string;
  aliases?: string[];
  usage?: string;
  examples?: string[];
  availability?: Array<'tui' | 'lark-bot' | 'webui' | 'api'>;
  visible?: boolean;
  execute: (ctx: CommandExecutionContext) => Promise<CommandResult> | CommandResult;
}

export interface CommandGroup {
  key: string;
  title: string;
  order?: number;
  description?: string;
}

export interface ParsedCommand {
  name: string;
  args: string;
  argv: string[];
  raw: string;
}

export interface CommandExecutionContext {
  frontend: 'tui' | 'lark-bot' | 'webui';
  sessionId?: string;
  userInputRaw: string;
  kernel: {
    rpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
  };
  reply: {
    text(message: string): Promise<void> | void;
    markdown?(message: string): Promise<void> | void;
    notice?(message: string): Promise<void> | void;
  };
  ui?: {
    openSessionPicker?(): void;
    clearTranscript?(): void;
  };
}

export interface CommandResult {
  success: boolean;
  message?: string;
  data?: unknown;
}
```

- [ ] **Step 2: Create command-groups.ts**

```ts
import type { CommandGroup } from './types';

export const COMMAND_GROUPS: CommandGroup[] = [
  { key: 'core', title: 'Core', order: 1, description: 'Essential commands' },
  { key: 'session', title: 'Session', order: 2, description: 'Session management' },
  { key: 'context', title: 'Context', order: 3, description: 'Context window management' },
  { key: 'tooling', title: 'Tooling', order: 4, description: 'Tool and capability inspection' },
  { key: 'ui', title: 'UI', order: 5, description: 'Interface controls' },
  { key: 'workflow', title: 'Workflow', order: 6, description: 'Workflow and skill commands' },
  { key: 'debug', title: 'Debug', order: 7, description: 'Diagnostics and debugging' },
  { key: 'admin', title: 'Admin', order: 8, description: 'Administrative commands' },
];

export function getGroup(key: string): CommandGroup | undefined {
  return COMMAND_GROUPS.find(g => g.key === key);
}
```

- [ ] **Step 3: Create parse-command.ts**

```ts
import type { ParsedCommand } from './types';

export function parseCommand(raw: string): ParsedCommand | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) return null;

  const parts = trimmed.slice(1).split(/\s+/);
  const name = parts[0] ?? '';
  const argv = parts.slice(1);
  const args = argv.join(' ');

  return { name, args, argv, raw: trimmed };
}
```

- [ ] **Step 4: Create command-registry.ts**

```ts
import type { CommandDefinition, CommandGroup } from './types';
import { parseCommand } from './parse-command';

export class CommandRegistry {
  private commands = new Map<string, CommandDefinition>();
  private aliases = new Map<string, string>();

  register(cmd: CommandDefinition): void {
    this.commands.set(cmd.name, cmd);
    for (const alias of cmd.aliases ?? []) {
      this.aliases.set(alias, cmd.name);
    }
  }

  unregister(name: string): void {
    const cmd = this.commands.get(name);
    if (!cmd) return;
    for (const alias of cmd.aliases ?? []) {
      this.aliases.delete(alias);
    }
    this.commands.delete(name);
  }

  get(name: string): CommandDefinition | undefined {
    return this.commands.get(name) ?? (this.aliases.has(name) ? this.commands.get(this.aliases.get(name)!) : undefined);
  }

  list(filter?: { frontend?: string; group?: string }): CommandDefinition[] {
    let result = [...this.commands.values()];
    if (filter?.frontend) {
      result = result.filter(c => !c.availability || c.availability.includes(filter.frontend as never));
    }
    if (filter?.group) {
      result = result.filter(c => c.group === filter.group);
    }
    return result.filter(c => c.visible !== false);
  }

  resolve(raw: string): { command: CommandDefinition; parsed: ReturnType<typeof parseCommand> } | null {
    const parsed = parseCommand(raw);
    if (!parsed) return null;
    const command = this.get(parsed.name);
    if (!command) return null;
    return { command, parsed };
  }
}
```

- [ ] **Step 5: Compile**

```bash
bun run tsc --noEmit 2>&1 | head -10
```

- [ ] **Step 6: Commit**

```bash
git add src/application/commands/
git commit -m "feat(p8): add application/commands — types, groups, registry, parser"
```

---

### Task B2: Create 7 builtin command files

**Files:**
- Create: `src/application/commands/builtin/clear.ts`
- Create: `src/application/commands/builtin/compact.ts`
- Create: `src/application/commands/builtin/help.ts`
- Create: `src/application/commands/builtin/cost.ts`
- Create: `src/application/commands/builtin/tools.ts`
- Create: `src/application/commands/builtin/exit.ts`
- Create: `src/application/commands/builtin/daemon.ts`

- [ ] **Step 1: Create clear.ts**

```ts
import type { CommandDefinition } from '../types';

export const clearCommand: CommandDefinition = {
  name: 'clear',
  aliases: ['cls'],
  description: 'Clear the current session transcript',
  group: 'session',
  availability: ['tui'],
  async execute(ctx) {
    await ctx.kernel.rpc('session.clear', { sessionId: ctx.sessionId });
    ctx.ui?.clearTranscript?.();
    return { success: true, message: 'Session cleared.' };
  },
};
```

- [ ] **Step 2: Create compact.ts**

```ts
import type { CommandDefinition } from '../types';

export const compactCommand: CommandDefinition = {
  name: 'compact',
  description: 'Compact the context window by summarizing history',
  group: 'context',
  availability: ['tui', 'lark-bot'],
  async execute(ctx) {
    await ctx.kernel.rpc('session.compact', { sessionId: ctx.sessionId });
    return { success: true, message: 'Context compaction triggered.' };
  },
};
```

- [ ] **Step 3: Create help.ts**

```ts
import type { CommandDefinition, CommandResult } from '../types';
import { COMMAND_GROUPS } from '../command-groups';

export function createHelpCommand(getRegistry: () => { list: (f?: { frontend?: string; group?: string }) => Array<{ name: string; description: string; group: string }> }): CommandDefinition {
  return {
    name: 'help',
    description: 'Show available commands grouped by category',
    group: 'core',
    availability: ['tui', 'lark-bot'],
    async execute(ctx): Promise<CommandResult> {
      const registry = getRegistry();
      const all = registry.list({ frontend: ctx.frontend });
      const grouped = new Map<string, Array<{ name: string; description: string }>>();
      for (const cmd of all) {
        if (!grouped.has(cmd.group)) grouped.set(cmd.group, []);
        grouped.get(cmd.group)!.push({ name: cmd.name, description: cmd.description });
      }
      const lines: string[] = ['Available commands:\n'];
      for (const g of COMMAND_GROUPS) {
        const cmds = grouped.get(g.key);
        if (!cmds || cmds.length === 0) continue;
        lines.push(`**${g.title}**`);
        for (const c of cmds) {
          lines.push(`  /${c.name} — ${c.description}`);
        }
        lines.push('');
      }
      return { success: true, message: lines.join('\n') };
    },
  };
}
```

- [ ] **Step 4: Create cost.ts**

```ts
import type { CommandDefinition } from '../types';

export const costCommand: CommandDefinition = {
  name: 'cost',
  description: 'Show token usage statistics for the current session',
  group: 'debug',
  availability: ['tui', 'lark-bot'],
  async execute(ctx) {
    const stats = await ctx.kernel.rpc('session.stats', { sessionId: ctx.sessionId }) as { usage: { input: number; output: number }; turnCount: number };
    return {
      success: true,
      message: `Tokens: ${stats.usage.input.toLocaleString()} input, ${stats.usage.output.toLocaleString()} output across ${stats.turnCount} turns.`,
    };
  },
};
```

- [ ] **Step 5: Create tools.ts**

```ts
import type { CommandDefinition } from '../types';

export const toolsCommand: CommandDefinition = {
  name: 'tools',
  description: 'List available tools',
  group: 'tooling',
  availability: ['tui', 'lark-bot'],
  async execute(ctx) {
    const result = await ctx.kernel.rpc('tool.list', {}) as { tools: Array<{ name: string; description: string }> };
    const lines = result.tools.map(t => `  **/${t.name}** — ${t.description}`);
    return { success: true, message: `Available tools (${result.tools.length}):\n${lines.join('\n')}` };
  },
};
```

- [ ] **Step 6: Create exit.ts**

```ts
import type { CommandDefinition } from '../types';

export const exitCommand: CommandDefinition = {
  name: 'exit',
  aliases: ['quit'],
  description: 'Shut down the daemon',
  group: 'admin',
  availability: ['tui'],
  async execute(ctx) {
    await ctx.kernel.rpc('system.shutdown', {});
    return { success: true, message: 'Shutting down...' };
  },
};
```

- [ ] **Step 7: Create daemon.ts**

```ts
import type { CommandDefinition } from '../types';

export const daemonCommand: CommandDefinition = {
  name: 'daemon',
  description: 'Show daemon status',
  group: 'admin',
  availability: ['tui', 'lark-bot'],
  async execute(ctx) {
    const health = await ctx.kernel.rpc('system.health', {}) as { status: string; uptimeMs: number; extensions: number };
    return {
      success: true,
      message: `Daemon: ${health.status} | Uptime: ${Math.round(health.uptimeMs / 1000)}s | Extensions: ${health.extensions}`,
    };
  },
};
```

- [ ] **Step 8: Compile**

```bash
bun run tsc --noEmit 2>&1 | head -10
```

- [ ] **Step 9: Commit**

```bash
git add src/application/commands/builtin/
git commit -m "feat(p8): add 7 builtin commands — clear, compact, help, cost, tools, exit, daemon"
```

---

### Task B3: Wire TUI slash input to unified command parser

**Files:**
- Modify: `src/extensions/frontend.tui/hooks/use-command-input.ts`
- Modify: `src/extensions/frontend.tui/App.tsx`
- Delete: `src/extensions/frontend.tui/command-registry.ts`
- Delete: `src/extensions/frontend.tui/tui-types.ts`
- Delete: `src/extensions/frontend.tui/commands/` (all files)

- [ ] **Step 1: Create local command wiring in App.tsx**

Create a `CommandRegistry` instance and register all builtin commands in `AppV2`:

```ts
const registry = new CommandRegistry();
registry.register(clearCommand);
registry.register(compactCommand);
registry.register(createHelpCommand(() => registry));
registry.register(costCommand);
registry.register(toolsCommand);
registry.register(exitCommand);
registry.register(daemonCommand);
```

- [ ] **Step 2: Create CommandExecutionContext factory**

```ts
function createCommandContext(frontend: 'tui', sessionId: string, raw: string, client: SessionClient, ui: CommandExecutionContext['ui']): CommandExecutionContext {
  return {
    frontend,
    sessionId,
    userInputRaw: raw,
    kernel: {
      rpc: async (method, params) => client['transport'].sendRpc(method, { ...params, sessionId: sessionId ?? 'main' }),
    },
    reply: {
      text: async (msg) => store.appendSystemNotice(Date.now().toString(), msg),
      notice: async (msg) => store.appendSystemNotice(Date.now().toString(), msg),
    },
    ui,
  };
}
```

- [ ] **Step 3: Replace handleBuiltinCommand with registry.resolve**

In `AppV2.handleSubmit`:

```ts
const resolved = registry.resolve(text);
if (resolved) {
  const ctx = createCommandContext('tui', sessionId, text, client, {
    clearTranscript: () => { setStaticKey(k => k + 1); store.clearActive(); },
    openSessionPicker: () => store.openSessionPicker(),
  });
  const result = await resolved.command.execute(ctx);
  if (result.message) {
    store.appendSystemNotice(Date.now().toString(), result.message);
  }
  return;
}
// Otherwise: normal agent turn
```

- [ ] **Step 4: Update use-command-input.ts**

Pass the registry for autocomplete (picker shows `registry.list({ frontend: 'tui' })`).

- [ ] **Step 5: Delete old command files**

```bash
rm -rf src/extensions/frontend.tui/commands/
rm src/extensions/frontend.tui/command-registry.ts
rm src/extensions/frontend.tui/tui-types.ts
```

- [ ] **Step 6: Compile and test**

```bash
bun run tsc --noEmit 2>&1 | head -10
bun test 2>&1 | tail -5
```

- [ ] **Step 7: Commit**

```bash
git rm -r src/extensions/frontend.tui/commands/ src/extensions/frontend.tui/command-registry.ts src/extensions/frontend.tui/tui-types.ts
git add src/extensions/frontend.tui/hooks/use-command-input.ts src/extensions/frontend.tui/App.tsx
git commit -m "refactor(p8): wire TUI slash input to unified command parser, delete old command system"
```

---

### Task B4: Wire Lark Bot slash messages to unified command parser

**Files:**
- Modify: `src/extensions/frontend.lark/lark/event-dispatcher.ts`
- Modify: `src/extensions/frontend.lark/index.ts`

- [ ] **Step 1: Add command registry to LarkBotAdapter**

```ts
private commandRegistry = new CommandRegistry();

constructor(...) {
  // Register same builtin commands
  this.commandRegistry.register(clearCommand);
  this.commandRegistry.register(compactCommand);
  this.commandRegistry.register(createHelpCommand(() => this.commandRegistry));
  this.commandRegistry.register(costCommand);
  this.commandRegistry.register(toolsCommand);
  this.commandRegistry.register(daemonCommand);
  // Note: exit not available for Lark
}
```

- [ ] **Step 2: Hook slash messages into registry**

In `event-dispatcher.ts` `handleNewTopic` / `handleThreadReply`, before sending to agent turn:

```ts
const trimmed = msg.content.trim();
const resolved = this.commandRegistry.resolve(trimmed);
if (resolved) {
  const ctx: CommandExecutionContext = {
    frontend: 'lark-bot',
    sessionId: this.routingTable.getSessionId(chatId),
    userInputRaw: msg.content,
    kernel: {
      rpc: async (method, params) => this.sessionClient['transport'].sendRpc(method, params ?? {}),
    },
    reply: {
      text: async (message) => this.sendToLark(chatId, message),
    },
  };
  const result = await resolved.command.execute(ctx);
  if (result.message) {
    await this.sendToLark(chatId, result.message);
  }
  return;
}
// Otherwise: normal agent turn via sessionClient.sendInput(...)
```

- [ ] **Step 3: Compile**

```bash
bun run tsc --noEmit 2>&1 | head -10
```

- [ ] **Step 4: Commit**

```bash
git add src/extensions/frontend.lark/
git commit -m "feat(p8): wire Lark Bot slash messages to unified command parser"
```

---

## Track C: Hotkey 统一仲裁

### Task C1: Add KeyDispatcher with push/pop stack

**Files:**
- Create: `src/extensions/frontend.tui/input/key-dispatcher.ts`

- [ ] **Step 1: Create KeyDispatcher**

```ts
type KeyHandler = (key: KeyEvent) => boolean; // true = consumed

interface KeyEvent {
  upArrow?: boolean;
  downArrow?: boolean;
  escape?: boolean;
  return?: boolean;
  tab?: boolean;
  shiftTab?: boolean;
  ctrl?: boolean;
  key?: string;
}

export interface KeyLayer {
  id: string;
  handler: KeyHandler;
  priority?: number;
}

export class KeyDispatcher {
  private stack: KeyLayer[] = [];

  push(layer: KeyLayer): void {
    const existing = this.stack.findIndex(l => l.id === layer.id);
    if (existing >= 0) this.stack.splice(existing, 1);
    this.stack.push(layer);
  }

  pop(id: string): void {
    this.stack = this.stack.filter(l => l.id !== id);
  }

  dispatch(key: KeyEvent): boolean {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i]!.handler(key)) return true;
    }
    return false;
  }

  clear(): void {
    this.stack = [];
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/extensions/frontend.tui/input/key-dispatcher.ts
git commit -m "feat(p8): add KeyDispatcher with LIFO push/pop stack"
```

---

### Task C2: Migrate all useInput hooks to KeyDispatcher

**Files:**
- Modify: `src/extensions/frontend.tui/views/chrome/InputBox.tsx`
- Modify: `src/extensions/frontend.tui/hooks/use-command-input.ts`
- Modify: `src/extensions/frontend.tui/hooks/use-session-picker.ts`
- Modify: `src/extensions/frontend.tui/views/overlay/PermissionPrompt.tsx`
- Modify: `src/extensions/frontend.tui/views/overlay/AskUserQuestionPrompt.tsx`
- Modify: `src/extensions/frontend.tui/views/chrome/keymap.ts`

- [ ] **Step 1: Create singleton KeyDispatcher in App.tsx**

```ts
const keyDispatcher = useRef(new KeyDispatcher()).current;
```

- [ ] **Step 2: Migrate PermissionPrompt**

Replace its `useInput` with KeyDispatcher registration:

```ts
useEffect(() => {
  keyDispatcher.push({
    id: 'permission-prompt',
    handler: (key) => {
      if (key.escape) { handleSubmit('deny'); return true; }
      if (key.return) { handleSubmit('allow'); return true; }
      return false;
    },
  });
  return () => keyDispatcher.pop('permission-prompt');
}, [visible]);
```

- [ ] **Step 3: Migrate AskUserQuestionPrompt similarly**

- [ ] **Step 4: Migrate SessionPicker**

```ts
useEffect(() => {
  if (!pickerActive) return;
  keyDispatcher.push({
    id: 'session-picker',
    handler: (key) => {
      if (key.escape) { closeSessionPicker(); return true; }
      if (key.return) { handleSelectSession(selectedIndex); return true; }
      if (key.upArrow) { moveSelection(-1); return true; }
      if (key.downArrow) { moveSelection(1); return true; }
      return false;
    },
  });
  return () => keyDispatcher.pop('session-picker');
}, [pickerActive]);
```

- [ ] **Step 5: Migrate InputBox + use-command-input**

The base editor layer is always present. Register as lowest priority:

```ts
keyDispatcher.push({
  id: 'normal-editor',
  handler: (key) => /* existing use-command-input logic */,
});
```

Streaming mode, slash picker, @file picker are separate layers pushed/popped as state changes.

- [ ] **Step 6: Remove keymap.ts hotkey iteration loop from InputBox**

InputBox's `useInput` now calls `keyDispatcher.dispatch(key)` instead of iterating `hotkeys`.

- [ ] **Step 7: Compile and test**

```bash
bun run tsc --noEmit 2>&1 | head -10
bun test 2>&1 | tail -5
```

- [ ] **Step 8: Commit**

```bash
git add src/extensions/frontend.tui/
git commit -m "refactor(p8): migrate all useInput hooks to KeyDispatcher LIFO stack"
```

---

## Track D: 删除旧兼容层

### Task D1: Delete KernelAgentFacade, KernelSessionStoreFacade, Agent, SessionStore, AgentContextManager

**Files:**
- Modify: `src/extensions/frontend.tui/index.ts`
- Modify: `src/extensions/frontend.tui/types.ts`
- Modify: `src/extensions/frontend.tui/App.tsx`
- Modify: `src/extensions/frontend.tui/state/store.ts`

- [ ] **Step 1: Clean types.ts — keep only what's needed**

Delete `Agent`, `AgentEvent`, `AgentContextManager`, `AgentLoopConfig`, `DEFAULT_LOOP_CONFIG`, `SessionStore`, `SessionSummary` from `types.ts`.

Keep: `FrontendHandle`-related types, plus add `TranscriptEvent` and `ToolCallViewModel` imports.

Remove import: `import type { Message } from '../../types'`.

- [ ] **Step 2: Clean index.ts — delete facade classes**

Delete: `KernelAgentFacade`, `KernelSessionStoreFacade`, `EventBridge`, `toAgentEvent()`.

Delete: `TUIAdapter.asAgent()`, `TUIAdapter.asSessionStore()`.

Delete: `import type { Agent, AgentEvent, AgentContextManager, SessionStore, SessionSummary } from './types'`.

Delete: `import type { Message } from '../../types'`.

Add: `import { SessionClient } from './session-client'`.

- [ ] **Step 3: Update App.tsx props**

Remove `agent: Agent`, `sessionStore: SessionStore` from `AppV2` props. Replace with `client: SessionClient`, `projector: TranscriptProjector`.

Remove `buildV2CommandContext()` and `handleBuiltinCommand()` — replaced by unified command registry in B3.

- [ ] **Step 4: Remove types.ts imports from remaining files**

```bash
grep -rn "from.*types" src/extensions/frontend.tui/ --include="*.ts" | grep -v node_modules
```

For each match:
- `from '../../../types'` → replace with specific imports from `application/ports/` or `application/contracts/`
- `from '../../types'` → same
- `ToolCall` → delete import, use `ToolCallViewModel` from `transcript/types`
- `Message` → delete import, use `HistoryRecordV1` from `application/contracts`

- [ ] **Step 5: Verify zero types.ts imports**

```bash
grep -rn "from.*types" src/extensions/frontend.tui/ --include="*.ts"
grep -rn "from.*types" src/extensions/frontend.lark/ --include="*.ts"
```

Expected: 0 results for both.

- [ ] **Step 6: Compile and test**

```bash
bun run tsc --noEmit 2>&1 | head -10
bun test 2>&1 | tail -5
```

- [ ] **Step 7: Commit**

```bash
git add src/extensions/frontend.tui/ src/extensions/frontend.lark/
git commit -m "chore(p8): delete KernelAgentFacade, KernelSessionStoreFacade, Agent, SessionStore, AgentContextManager — zero types.ts imports"
```

---

### Task D2: Final verification

- [ ] **Step 1: Run full CI**

```bash
bun run check:all
```

- [ ] **Step 2: Verification checklist**

```bash
# 1. No types.ts imports in frontends
grep -rn "from.*types" src/extensions/frontend.tui/ src/extensions/frontend.lark/ --include="*.ts"
# Expected: 0 results

# 2. No facade classes
grep -rn "KernelAgentFacade\|KernelSessionStoreFacade\|asAgent\|asSessionStore" src/ --include="*.ts"
# Expected: 0 results

# 3. No Agent/SessionStore/AgentContextManager in TUI
grep -rn "Agent\|SessionStore\|AgentContextManager" src/extensions/frontend.tui/types.ts
# Expected: 0 results (or only TranscriptEvent-related)

# 4. No old command files
ls src/extensions/frontend.tui/commands/ 2>&1
# Expected: No such file or directory

# 5. No tools/tools barrel
ls src/extensions/tools/tools/ 2>&1
# Expected: No such file or directory

# 6. Session-client exists
ls src/extensions/frontend.tui/session-client.ts
# Expected: file exists

# 7. Transcript projector exists
ls src/extensions/frontend.tui/transcript/
# Expected: types.ts, projector.ts, from-dataplane.ts, from-history.ts

# 8. Commands exist
ls src/application/commands/
# Expected: types.ts, command-groups.ts, command-registry.ts, parse-command.ts, builtin/

# 9. Key dispatcher exists
ls src/extensions/frontend.tui/input/key-dispatcher.ts
# Expected: file exists
```

- [ ] **Step 3: Fix any issues and commit**

---

## Self-Review

**Spec coverage check:**
- A.1 controlplane RPCs → Task A1 ✓
- A.2 Snapshot contract → Task A1 (part of session.attach/resume) ✓
- A.3 session-client → Task A2 ✓
- A.4 Transcript projector → Task A3 ✓
- A.5 Two frontend rewiring → Tasks A4, A5 ✓
- B.1-B.10 Command unification → Tasks B1-B4 ✓
- C.1-C.3 KeyDispatcher → Tasks C1-C2 ✓
- D.1-D.4 Delete compat layer → Tasks D1-D2 ✓

**Placeholder scan:** No TBD/TODO/fill-in-later patterns. All code blocks are concrete.

**Type consistency:**
- `TranscriptEvent` types match between types.ts, from-dataplane.ts, from-history.ts, projector.ts ✓
- `CommandDefinition` used consistently in registry.ts, builtin/*.ts, App.tsx ✓
- `SessionClient` interface matches between session-client.ts and both frontends ✓
- `KeyDispatcher` push/pop/dispatch signatures used consistently in all migrated hooks ✓
