# Lark Streaming Card Adapter — Implementation Spec (v5, with F1-F3 patches)

> **Status**: Ready. **Repo**: `my-agent-dev`, branch `feature/lobster-m1-kernel`.
> **Architecture**: Lobster v2.0 (contracts ← ports ← usecases ← extensions/infrastructure).
> **Estimated**: ~900 LOC new, ~100 LOC modified, 4 commits.

---

## 1. Goal

Replace single-shot text reply with **streaming CardKit 2.0 card** updated in real-time as agent emits events. Visual semantics from [feishu-claude-code-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge) (MIT; vendored).

1. On user message: immediately add `Typing` reaction to user's message.
2. Open streaming card as reply to user's message.
3. Subscribe to DataPlane events; reduce into `RunState`; re-render card.
4. Render rules: thinking→grey panel, text→markdown, tools→collapsible panels (3+ auto-collapse), errors/cancel/completion→footer note, running footer→status line.
5. On `turn.completed`/`turn.failed`: finalize card, remove reaction.
6. Cancel via `/cancel` slash command.
7. No header/status badge/buttons — minimalist.

## 2. Non-goals

- Idle-timeout watchdog (Phase 2). Markdown fallback (Phase 2). CardKit 1.0.

## 3. Architecture

```
Bus events → DataPlane → transport.onEvent → LarkBotAdapter → TurnCardController
                                                              ↓
                                              reduce(state, event) → renderCard → SDK CardStreamController.update()
```

SDK `LarkChannel.stream()` handles sequence, throttling, 30000-char rollover.

## 4. File plan

### New vendor/ files (MIT attribution header)

| File | Purpose |
|------|---------|
| `vendor/agent-event.ts` | `AgentEvent` discriminated union |
| `vendor/run-state.ts` | Pure reducer: `reduce(state, evt)→state` |
| `vendor/tool-render.ts` | Tool header/body markdown helpers |
| `vendor/run-renderer.ts` | `renderCard(state)→CardKit 2.0 JSON` (Stop button removed) |
| `vendor/text-renderer.ts` | Plain markdown fallback (future Phase 2) |
| `vendor/reaction.ts` | `addWorkingReaction`/`removeReaction` |

### New own files

| File | Purpose |
|------|---------|
| `internal/data-plane-to-agent-event.ts` | Map `DataPlaneEvent`→`AgentEvent` (uses `tool.update`+`phase`, NOT `tool.executed`) |
| `internal/turn-card-controller.ts` | Per-turn lifecycle around SDK `CardStreamController` |
| `../frontend.tui/slash/builtin/slash-cancel.ts` | `/cancel` slash command |

### Modified files

| File | Change |
|------|--------|
| `lark-bot-adapter.ts` | Drop `pendingText`. Add `turnControllers`/`pendingReplyTo`/`pendingReactions` maps. Eager card open before `sendInput` (F3). Check `queued` return (F2). Wire reaction add/remove. Register `/cancel`. |
| `internal/event-dispatcher.ts` | Pass `messageId` to handlers already — verify. |
| `internal/types.ts` | Verify `messageId: string` on `RoutingContext`. |

---

## 5. F1 — `data-plane-to-agent-event.ts` uses `tool.update`+`phase`

DataPlane maps `tool.start`/`tool.end` → `tool.update` with `phase: 'start'|'end'` injected. TurnEvent has `callId` as stable id. No `tool.executed` DataPlane type.

Mapping table:

| DataPlane type | payload.phase | → AgentEvent |
|---|---|---|---|
| `assistant.delta` / `llm.delta` | — | `{ type:'text', delta }` |
| `tool.update` | `'start'` | `{ type:'tool_use', id:callId, name, input:args }` |
| `tool.update` | `'end'` | `{ type:'tool_result', id:callId, output:result, isError }` |
| `turn.completed` | — | `{ type:'done' }` |
| `turn.failed` | — | `{ type:'error', message:reason }` |

## 6. F2 — Handle queued input

`sendInput` returns `{ accepted, sessionId, queued?, queueDepth? }`. When `queued: true`: synchronously remove the reaction just added, reply with "_当前回合还在进行,请使用 /cancel 后重发_".

`SessionClient.sendInput` return type changed from `void` to the actual RPC result.

## 7. F3 — Eager card open before `sendInput`

To eliminate `turn.started` race: `handleMessage` opens the card controller **before** `sendInput`, storing it in `pendingControllers` by sessionId. When `turn.started` arrives, move to `turnControllers`. If `turn.started` arrives with no pending controller (shouldn't happen), create one without `replyTo`.

Sequence:
```
handleMessage:
  1. set(sessionChatMap, chatId)
  2. set(pendingReplyTo, messageId)
  3. addWorkingReaction → store reactionId in pendingReactions
  4. TurnCardController.open(channel, chatId, messageId) → set in pendingControllers
  5. sendInput
     a. if queued: remove reaction, reply tip, return
  6. (turn.started arrives async in event subscriber)
     a. move pendingControllers→turnControllers
  7. (streaming events feed controller)
  8. (turn.completed/turn.failed: finalize, remove reaction)
```

## 8. File contents (verbatim)

### 8.1 `vendor/agent-event.ts`

```ts
/**
 * Vendored from feishu-claude-code-bridge (MIT, 2025).
 * Source: https://github.com/zarazhangrui/feishu-claude-code-bridge
 * Modifications: trimmed to the union only.
 */
export type AgentEvent =
  | { type: 'system'; sessionId?: string; cwd?: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: 'done'; sessionId?: string }
  | { type: 'error'; message: string };
```

### 8.2 `vendor/run-state.ts`

```ts
/**
 * Vendored from feishu-claude-code-bridge (MIT, 2025).
 * Modifications: none.
 */
import type { AgentEvent } from './agent-event';

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolEntry {
  id: string; name: string; input: unknown; status: ToolStatus; output?: string;
}

export type Block =
  | { kind: 'text'; content: string; streaming: boolean }
  | { kind: 'tool'; tool: ToolEntry };

export type FooterStatus = 'thinking' | 'tool_running' | 'streaming' | null;
export type Terminal = 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout';

export interface RunState {
  blocks: Block[];
  reasoning: { content: string; active: boolean };
  footer: FooterStatus;
  terminal: Terminal;
  errorMsg?: string;
  idleTimeoutMinutes?: number;
}

export const initialState: RunState = {
  blocks: [], reasoning: { content: '', active: false },
  footer: 'thinking', terminal: 'running',
};

function closeStreamingText(blocks: Block[]): Block[] {
  return blocks.map((b) => b.kind === 'text' && b.streaming ? { ...b, streaming: false } : b);
}

export function reduce(state: RunState, evt: AgentEvent): RunState {
  switch (evt.type) {
    case 'text': {
      const last = state.blocks[state.blocks.length - 1];
      if (last && last.kind === 'text' && last.streaming) {
        return { ...state, blocks: [...state.blocks.slice(0, -1), { ...last, content: last.content + evt.delta }], reasoning: { ...state.reasoning, active: false }, footer: 'streaming' };
      }
      return { ...state, blocks: [...state.blocks, { kind: 'text', content: evt.delta, streaming: true }], reasoning: { ...state.reasoning, active: false }, footer: 'streaming' };
    }
    case 'thinking':
      return { ...state, reasoning: { content: state.reasoning.content + evt.delta, active: true }, footer: 'thinking' };
    case 'tool_use': {
      const tool: ToolEntry = { id: evt.id, name: evt.name, input: evt.input, status: 'running' };
      return { ...state, blocks: [...closeStreamingText(state.blocks), { kind: 'tool', tool }], reasoning: { ...state.reasoning, active: false }, footer: 'tool_running' };
    }
    case 'tool_result': {
      const blocks = state.blocks.map((b) => {
        if (b.kind !== 'tool' || b.tool.id !== evt.id) return b;
        return { ...b, tool: { ...b.tool, status: evt.isError ? 'error' as const : 'done' as const, output: evt.output } };
      });
      return { ...state, blocks };
    }
    case 'error':
      return { ...state, terminal: 'error', errorMsg: evt.message, footer: null };
    case 'done':
      return { ...state, blocks: closeStreamingText(state.blocks), reasoning: { ...state.reasoning, active: false }, terminal: 'done', footer: null };
    default:
      return state;
  }
}

export function markInterrupted(state: RunState): RunState {
  return { ...state, blocks: closeStreamingText(state.blocks), reasoning: { ...state.reasoning, active: false }, terminal: 'interrupted', footer: null };
}

export function finalizeIfRunning(state: RunState): RunState {
  if (state.terminal !== 'running') return state;
  return { ...state, blocks: closeStreamingText(state.blocks), reasoning: { ...state.reasoning, active: false }, terminal: 'done', footer: null };
}
```

### 8.3-8.5 `vendor/tool-render.ts`, `vendor/run-renderer.ts`, `vendor/text-renderer.ts`, `vendor/reaction.ts`

Same as original spec §5.3-5.6.

### 8.6 `internal/data-plane-to-agent-event.ts` (F1 applied)

```ts
import type { DataPlaneEvent } from '../../../application/contracts';
import type { AgentEvent } from '../vendor/agent-event';

export function mapDataPlaneToAgentEvent(evt: DataPlaneEvent): AgentEvent | null {
  const payload = (evt.payload ?? {}) as Record<string, unknown>;
  switch (evt.type) {
    case 'assistant.delta':
    case 'llm.delta': {
      const delta = typeof payload.delta === 'string' ? payload.delta : '';
      if (!delta) return null;
      return { type: 'text', delta };
    }
    case 'tool.update': {
      const phase = payload.phase as 'start' | 'end' | undefined;
      const id = (payload.callId as string) ?? `${evt.evId}`;
      const name = (payload.name as string) ?? 'unknown';
      if (phase === 'start') return { type: 'tool_use', id, name, input: payload.args ?? {} };
      if (phase === 'end') {
        const isError = payload.err != null;
        const output = typeof payload.result === 'string' ? payload.result : JSON.stringify(payload.result ?? '');
        return { type: 'tool_result', id, output, isError };
      }
      return null;
    }
    case 'turn.completed':
      return { type: 'done' };
    case 'turn.failed': {
      const reason = typeof payload.reason === 'string' ? payload.reason : 'unknown';
      return { type: 'error', message: reason };
    }
    default:
      return null;
  }
}
```

### 8.7 `internal/turn-card-controller.ts`

Same as original spec §5.8. No `mapToolExecutedAsPair` — uses single `mapDataPlaneToAgentEvent` path.

### 8.8 `../frontend.tui/slash/builtin/slash-cancel.ts`

Same as original spec §5.9.

## 9. `lark-bot-adapter.ts` modifications (F2+F3 applied)

### Fields

```ts
private turnControllers = new Map<string, TurnCardController>()
private pendingControllers = new Map<string, TurnCardController>()  // F3: before sendInput
private pendingReplyTo = new Map<string, string>()
private pendingReactions = new Map<string, string>()
```

### Constructor

Register `slashCancelCommand`.

### `start()` event subscriber

```ts
this.transport.onEvent((event) => {
  // ... projector push ...
  if (!event.sessionId) return

  if (event.type === 'turn.started') {
    // F3: move pending→active
    const pending = this.pendingControllers.get(event.sessionId)
    if (pending) {
      this.turnControllers.set(event.sessionId, pending)
      this.pendingControllers.delete(event.sessionId)
    }
    return
  }

  const ctrl = this.turnControllers.get(event.sessionId)
  if (ctrl) void ctrl.feed(event)

  if (event.type === 'turn.completed' || event.type === 'turn.failed') {
    const outcome = event.type === 'turn.failed'
      ? ((event.payload as Record<string, unknown>)?.outcome === 'aborted' ? 'interrupted' as const : 'error' as const)
      : 'done' as const
    const errMsg = outcome === 'error' ? String((event.payload as Record<string, unknown>)?.reason ?? 'unknown') : undefined
    if (ctrl) { void ctrl.finalize(outcome, errMsg).finally(() => this.turnControllers.delete(event.sessionId)) }
    // Remove reaction
    const rid = this.pendingReactions.get(event.sessionId)
    const msgId = this.pendingReplyTo.get(event.sessionId)
    if (rid && msgId && this.channel) void removeReaction(this.channel, msgId, rid)
    this.pendingReactions.delete(event.sessionId)
    this.pendingReplyTo.delete(event.sessionId)
    // Clean up pending controller if never started
    this.pendingControllers.delete(event.sessionId)
  }
})
```

### `handleMessage` — eager open + queued check (F2+F3)

```ts
async handleMessage(anchor, text, chatId?, messageId?): Promise<{sessionId, accepted}> {
  // ... slash command handling (unchanged) ...

  // ... session resolution (unchanged) ...

  if (chatId) this.sessionChatMap.set(sessionId, chatId)
  if (messageId) this.pendingReplyTo.set(sessionId, messageId)

  // F2: add reaction before sendInput
  if (messageId && this.channel) {
    const rid = await addWorkingReaction(this.channel, messageId)
    if (rid) this.pendingReactions.set(sessionId, rid)
  }

  // F3: eager card open before sendInput
  if (this.channel && chatId) {
    void TurnCardController.open(this.channel, chatId, messageId)
      .then(ctrl => {
        if (!this.turnControllers.has(sessionId)) {
          this.pendingControllers.set(sessionId, ctrl)
        }
      })
      .catch(err => ctxLogger.warn('lark', `open card failed: ${String(err)}`))
  }

  // Send input
  let result: { accepted?: boolean; queued?: boolean } = {}
  try {
    result = await this.sessionClient.sendInput(sessionId, text) as { accepted?: boolean; queued?: boolean }
  } catch { /* fallback */ }

  // F2: if queued, remove reaction + reply tip
  if (result?.queued) {
    const rid = this.pendingReactions.get(sessionId)
    if (rid && messageId && this.channel) {
      void removeReaction(this.channel, messageId, rid)
    }
    this.pendingReactions.delete(sessionId)
    // Clean up pending controller
    const pending = this.pendingControllers.get(sessionId)
    if (pending) { void pending.finalize('done').finally(() => this.pendingControllers.delete(sessionId)) }
    if (chatId) {
      void this.sendToLark(chatId, '_当前回合还在进行,请使用 /cancel 后重发_').catch(() => {})
    }
  }

  return { sessionId, accepted: result?.accepted ?? true }
}
```

## 10. Commit split

| # | Subject | Scope |
|---|---|---|
| A | `feat(lark): vendor FCCB run-state/renderer/tool-render/text-renderer/reaction (MIT)` | 6 vendor files |
| B | `feat(lark): streaming card adapter via TurnCardController` | data-plane-to-agent-event, turn-card-controller, adapter rewrite + F1/F2/F3, dispatcher messageId |
| C | `feat(slash): /cancel command routes to input.cancel` | slash-cancel.ts + registration |
| D | `feat(lark): Typing reaction + finalize hooks` | Reaction wiring, queued-input handling, error rendering |

## 11. Acceptance criteria

- [ ] P2P chat: Typing reaction appears, streaming card updates, reaction removed on done
- [ ] Tool calls: panels show per tool, 3+ auto-collapse
- [ ] `/cancel`: card shows interrupted, reaction removed
- [ ] Turn running: second message gets queued warning, reaction cleaned up
- [ ] Turn failed: card shows error reason
- [ ] `tsc`, `lint`, `test` all pass at each commit
