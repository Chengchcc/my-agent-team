# TUI 接线补全 + Sub-Agent M3 Follow-up

> **Status**: Final (grilled 2026-05-30)
> **Predecessors**: Sub-Agent M3 (commits `4d7b4e5` → `d40291d`), TUI deep review
> **Scope**: 修复 TUI 已识别的全部数据流断线、补全 token usage 端到端链路、收掉 sub-agent M3 落地后剩余的 P1/P2 问题。
> **Final LOC**: ~1154 (经 7 轮 grilling 从原 1360 减至 1154)
> **PRs**: 7

---

## 0. 范围一图

```
┌─ Group U: Token Usage 端到端 ───────────────────────┐
│  U-1 OpenAI adapter usage / U-2 Claude adapter usage│
│  U-3 session emit null 泄漏 / U-4 accumulateUsage    │
│  U-5 contextTokens 估算口径                          │
└─────────────────────────────────────────────────────┘
                          ↓
┌─ Group D: 致命断线(用户可见) ────────────────────────┐
│  D-1 permission overlay / D-2 ask-user-question      │
│  D-3 subagent in-process 死线清理                    │
└─────────────────────────────────────────────────────┘
                          ↓
┌─ Group W: 接线补全(隐性 UX) ────────────────────────┐
│  W-1 mode badge / W-2 todo_write prompt / W-3 /clear│
│  W-4 review notification(删) / W-5 todos store(删)  │
└─────────────────────────────────────────────────────┘
                          ↓
┌─ Group T: 代码质量清扫 ──────────────────────────────┐
│  T-1 死 action / T-2 turnDone fallback / T-3 useLive│
│  T-5 committer notifyScheduled 注释                  │
└─────────────────────────────────────────────────────┘
                          ↓
┌─ Group M: M3 follow-up ─────────────────────────────┐
│  M-1 concurrency counter / M-2 dataplane sub-agent   │
│  M-3 SubAgentErrorType + warn 状态 / M-4 isEmpty    │
│  M-5 widget-bridge dispose / M-6 死注释              │
└─────────────────────────────────────────────────────┘
```

---

## 1. Group U — Token Usage 端到端

### U-1 — OpenAI adapter 丢弃 `response.completed` 里的 usage

**Root cause**: `src/infrastructure/llm/adapters/openai-adapter.ts:120-122`

```ts
case 'response.completed':
case 'response.done':
  return { type: 'done' }   // ← event.response.usage 被丢弃
```

**Decision U-1.a**: `fromChatStreamChunk` 签名改为 `ChatResponseChunk[] | null`（一进多出）。理由：turn-runner.ts:38-40 已有 `usage` case，adapter 发出来就立刻接上。

**Decision U-1.b**: `ChatResponseChunk.done` 加 `finishReason` 字段。当前 done 是 `{ type: 'done' }`（provider.ts:32），turn-runner L95 用 `toolCalls.length > 0 ? 'tool_use' : 'stop'` 推断——永远推不出 `length` / `content_filter`。顺手修 M-4 根因。

**实施**:
- `application/ports/provider-adapter.ts`: 签名 `ChatResponseChunk[] | null`
- `application/ports/provider.ts`: done chunk 加 `finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter'`
- `infrastructure/llm/openai-provider.ts`: `for (const chunk of chunks ?? []) yield chunk`
- `infrastructure/llm/claude-provider.ts`: 同上，外层 for-of，内部状态机不变
- `infrastructure/llm/adapters/openai-adapter.ts`: `response.completed` 返回 `[{ type: 'usage', usage: { input, output } }, { type: 'done', finishReason }]`
- `infrastructure/llm/adapters/claude-adapter.ts`: provider 闭包累积 usage，message_stop 时 emit `[usage, done]`（Decision U-2.c: message_stop 一次性）
- `infrastructure/llm/echo-provider.ts`: done chunk 加 `finishReason: 'stop'`
- `domain/turn-runner.ts`: 用 chunk.finishReason 替代推断；RoundResult 加 finishReason 字段

**LOC**: ~110

### U-2 — Claude adapter 丢弃 `message_start` + `message_delta` 里的 usage

**Decision U-2.a**: Claude usage 累积在 provider 层闭包（非 adapter state）。
**Decision U-2.c**: message_stop 一次性 yield usage chunk（非每次 message_delta）。
**理由**: message_delta 每次覆盖最新 outputTokens（非 delta），若每次 yield 则 turn-runner `+=` 会错误累加。

**实施**: claude-provider.ts stream 方法内闭包维护 `pendingInput`（从 message_start）+ `pendingOutput`（从 message_delta），在 adapter 返回 done chunk 时先 yield `{ type: 'usage', usage: { input: pendingInput, output: pendingOutput } }` 再 yield done。

### U-3 — session emit usage 用 `?? null`

**Root cause**: `src/extensions/session/index.ts:94`
```ts
usage: { input: result.usage?.input ?? null, output: result.usage?.output ?? null }
```

**修法**: 改为 `usage: result.usage ?? { input: 0, output: 0 }`（整体兜底）。dataplane contract 保证 `{ input: number; output: number }`（非 optional 非 null）。

### U-4 — `accumulateUsage` 语义不一致

**Decision U-4.a**: 拆成两个 action：`setPromptTokens`（覆盖，每 turn 最新）+ `accumulateCompletionTokens`（累加，全会话累计）。
- `stats.promptTokens` → `lastTurnInputTokens`
- `stats.completionTokens` 保留
- `accumulateUsage` 删除

### U-5 — `setContextTokens` 估算口径错误

**Root cause**: use-agent-subscription.ts:67: `(s.promptTokens || 0) + (s.completionTokens || 0)` — 用上一轮 input + 累计 output，完全是另一个东西。

**Decision U-5.a**: contextTokens = lastTurnInputTokens（等价 selector）。Footer.tsx 直接读 `stats.lastTurnInputTokens`。删除 `setContextTokens` action。

### U 组不变式

| ID | 断言 |
|---|---|
| I-U1 | OpenAI `response.completed` 含 usage 时返回 `[{type:'usage'},{type:'done',finishReason}]` |
| I-U2 | Claude message_start/delta×3/stop → 收到 chunk 序列含且仅含一个 `{type:'usage'}` 在 `{type:'done'}` 之前 |
| I-U1c | done chunk MUST 携带 finishReason，turn-runner MUST 透传，禁止本地推断 |
| I-U1d | fromChatStreamChunk 返回数组时 chunk 顺序代表 wire 顺序；调用方 MUST 按序 yield |
| I-U3 | session 不 emit `null` usage；缺失时 emit `{ input: 0, output: 0 }` |
| I-U4 | 两次 `setPromptTokens(100)`/`setPromptTokens(200)` 后是 200；两次 `accumulateCompletion(50)`/`accumulateCompletion(30)` 后是 80 |
| I-U5 | Footer contextTokens == lastTurnInputTokens |

---

## 2. Group D — 致命断线

### D-1 — Permission overlay 没收到 dataplane 事件

**Root cause**: use-agent-subscription.ts:122-125: permission_requested case 体为空。

**Decision D-1.a**: 在 `use-agent-subscription` 的 case 里直接调 `_enqueuePermissionRequest`。
**Decision D-1.b**: 用 controlplane RPC `permission.resolve`（已存在于 permission/index.ts:148）。
**Decision D-1.c**: 改单例为 FIFO 队列（当前 `_enqueuePermissionRequest` 用 `let current` 单例，并发会覆盖）。

**实施**:
```ts
case 'permission_requested': {
  const resp = await _enqueuePermissionRequest({
    toolName: event.toolName,
    reason: `Tool "${event.toolName}" requires permission`,
  });
  void client.callRpc('permission.resolve', {
    reqId: event.reqId, decision: resp, sessionId,
  });
  break;
}
```

### D-2 — Ask-user-question overlay 完全没 dataplane case

**Root cause**: from-dataplane.ts 没有 `ask-user-question.required` 的 case（dataplane 已登记映射）。

**Decision D-2.a**: 复用 `user.answer` RPC（controlplane/methods.ts:81，handler 期望 `{ sessionId, questionId, answers }`）。
**实施**: from-dataplane.ts 加 case → transcript/types.ts 已有 `user_question_requested` → use-agent-subscription 调 `_enqueueAskUserQuestion` → 调 `client.callRpc('user.answer', { questionId, answers })`。
同 D-1.c，改 `_enqueueAskUserQuestion` 为 FIFO 队列。

### D-3 — Subagent in-process 死线清理

**决策**: 全删（M3 widget 是唯一对外契约）。
- 删 `state/types.ts` 的 `subagent-block` FinalItem 变体
- 删 `state/store.ts` 的 `subagentStarted`/`subagentCompleted` action
- 删 `views/final/FinalItemView.tsx` 的 `case 'subagent-block':` 分支
- 删 `transcript/types.ts` 的 `subagent_started`/`subagent_completed`
- 删 `use-agent-subscription.ts` 的两个 case
- 删 dataplane 的 `sub-agent.*` 3 个 DP 事件（见 M-2）

### D 组不变式

| ID | 断言 |
|---|---|
| I-D1 | permission_requested 事件触发 _enqueuePermissionRequest |
| I-D2 | user_question_requested 事件触发 _enqueueAskUserQuestion |
| I-D1.c | 并发 2 个 permission request，逐个 prompt，不覆盖 |
| I-D3 | subagent-block FinalItem 类型不存在（tsc + grep 验证） |

---

## 3. Group W — 接线补全

### W-1 — Mode badge 接线

**现状**: session-mode ext emit `session.modeChanged` ✓，dataplane builtInMappings 缺 ✗，from-dataplane 缺 ✗，TUI startup/reconnect 不回读当前 mode ✗。

**Gap inventory**:

| # | 描述 |
|---|---|
| 1 | dataplane builtInMappings 缺 `session.modeChanged → session.mode-changed` |
| 2 | DataPlaneEventType 缺 `'session.mode-changed'` |
| 3 | from-dataplane.ts 缺 case |
| 4 | transcript/types.ts 缺 `mode_changed` 变体 |
| 5 | use-agent-subscription.ts 缺 case |
| 6 | TUI attach/reconnect 后不回读当前 mode |

**实施** (~60 LOC):
- dataplane-event.ts: 加 `'session.mode-changed'`
- dataplane/index.ts builtInMappings: 加映射
- from-dataplane.ts: 加 case → `{ type: 'mode_changed', mode }`
- transcript/types.ts: 加 `{ type: 'mode_changed'; mode: string }`
- use-agent-subscription.ts: 加 `case 'mode_changed' → store.setMode(event.mode)`
- session-mode/index.ts: 加 RPC `session.getMode` → `{ mode }`
- session-client.ts: 加 `getMode(sid)` 方法
- App.tsx: session attach 后调 `client.getMode(sid)` → `setMode`

**不变式**:
- I-W1a: `stats.mode` 默认值 MUST 为 `'normal'`
- I-W1b: TUI 接入新 session 时 MUST 在 session_snapshot_loaded 后调用 `session.getMode` RPC
- I-W1c: `session.mode-changed` 在 dataplane 中是非快照型（仅记录变更），前端不得依赖 replay 还原 mode

### W-2 — Todo list widget 恢复（prompt-only）

**最终决策**: 不持久化，不 derive from history。改 `TODO_WRITE_GUIDANCE` prompt 让 todo_write 真正活跃，模型 resume 后按 prompt 指示重发完整列表。

**理由**:
- 现 prompt 触发率 < 5%，todo_write 接近死代码
- 新 prompt 触发 ANY of（非 ALL of），proactively（非 SPARINGLY）
- 显式要求 resume 时 re-send 完整列表
- 持久化（sidecar / derive）解决的是低频功能的低频场景，ROI 倒挂
- "下一 turn 才能看到 todo" 在 resume 语境下几乎无感知

**实施** (~25 LOC):
- tools/index.ts:198-211 替换 TODO_WRITE_GUIDANCE

**不变式**:
- I-W2a: Todo state has NO server-side persistence beyond history
- I-W2b: `/clear` 清掉 todos 通过清掉 history 实现
- I-W2c: Resume 后首屏不显示 todo widget；下一 turn 模型按 prompt 重发时 widget 恢复

**Rejected alternatives**:
- Sidecar JSON 文件：~185 LOC + 新协议 + 新 /clear 协调点
- Derive from history：~50 LOC，多换的"立即可见"不构成实质 UX 差异

### W-3 — `/clear` 语义对齐 Claude Code + Divider

**Decision W-3.a**: 对齐 Claude Code——scrollback 保留 + store.finalized 保留 + history 清 + divider。
**Decision W-3.b**: divider 走 store.finalized push `{ kind: 'divider', reason }`，FinalItemView 渲染。
**Decision W-3.c**: 删 `clearTranscript` hook（不写 `\x1b[2J\x1b[3J`，不 setStaticKey，不 clearActive）。
**Decision W-3.d**: stats 重置由 server 端 `session.cleared` 事件触发（单向数据流）。

**竞态修复** (grilling Q6):
- `session.clear` RPC handler 加 `waitDrained(sessionId, 2000ms)` 等待 turn 真正退出
- `session.abort` 能力扩展 `waitDrained` 方法：drainPromises map 跟踪 turn 生命周期
- runTurnUsecase Phase 6 入口加 `if (controller.signal.aborted) return` 兜底

**不变式**:
- I-W3a: /clear 后 finalized 末尾是 divider，前面 history 保留
- I-W3b: /clear 不再写 `\x1b[2J\x1b[3J` 到 stdout
- I-W3c: session.cleared 事件触发 resetStats
- I-W3e: `history.clear()` 调用前，该 sessionId 上的任何 turn-runner MUST 已从 try-finally 退出
- I-W3f: runTurnUsecase Phase 6 入口 MUST 重新检查 `controller.signal.aborted`

**实施** (~165 LOC):
- App.tsx: 删 `ui.clearTranscript`，加 `ui.appendDivider`
- slash-clear.ts: 调 `appendDivider('clear')`
- slash-compact.ts: 调 `appendDivider('compact')`
- dataplane: 加 `session.cleared` 映射
- transcript/types.ts + from-dataplane.ts + use-agent-subscription.ts: 加 `session_cleared` → `resetStats`
- session/index.ts: 加 `waitDrained` 能力
- rpc-handlers.ts: clear handler 加 `await waitDrained`
- run-turn-usecase: Phase 6 入口加 abort 检查

### W-4 — Review notification overlay（删除）

**最终决策**: 纯删除。Evolution 从未 emit `evolution.skillProposed`，overlay 永远是空渲染，且 useInput 全局占用 k/d 键位。

**实施** (~ -96 LOC):
- 删除 `overlay-review-notification.tsx`（整个文件）
- 删除 App.tsx import + `<OverlayReviewNotification />`
- 删除 store 的 4 个 review action + reviewNotifications 字段 + buildReviewActions
- 删除 types.ts 的 ReviewNotification 接口
- 删除 dataplane-event.ts 的 `'evolution.skillProposed'` 幽灵契约
- 删除 frontend.lark 的对应 case

**不变式**:
- I-W4a: TUI 不订阅 `evolution.review.*` 任何事件
- I-W4b: dataplane-event 枚举必须有真实 emit 端；无 emit 的契约不得保留

### W-5 — Todos store 字段（删除）

**决策**: 删 `store.todos` 字段和 `updateTodos` action。Todos 实际通过 widget 路径渲染。

### W 组不变式汇总

| ID | 断言 |
|---|---|
| I-W1a/b/c | mode badge 增量 + 快照路径 |
| I-W2a/b/c | todo prompt-only |
| I-W3a/b/c/e/f | /clear Claude 对齐 + 竞态修复 |
| I-W4a/b | review notification 删除验证 |
| I-W5 | store.todos 不存在 |

---

## 4. Group T — 代码质量清扫

### T-1 — 死 action 删除清单

| Action | 决策 |
|---|---|
| `setMode` | 保留（W-1 接线） |
| `updateTodos` | 删（W-5） |
| `addReviewNotification` / `dismissReviewNotification` / `keepReviewSkill` / `deleteReviewSkill` | 删（W-4） |
| `appendDivider` | 保留（W-3 接线） |
| `subagentStarted` / `subagentCompleted` | 删（D-3） |
| `accumulateUsage` / `setContextTokens` | 删（U-4/U-5 重构） |

### T-2 — `turnDone` fallback 死分支

**Root cause**: `turnStart` 无条件 push `assistant-header`，`hasGranular` 永远 true。Fallback push `assistant-message` 分支永远走不到。

**修法**: 删 fallback 块，加注释 "turnStart unconditionally pushes assistant-header，so granular items guaranteed to exist."

### T-3 — `useLiveItem` selector 反 React 规则

**修法**: 改用 `useTuiStore(s => s.live)` 朴素选择器。LiveAssistant 在 streaming 期间频繁 push delta，重渲染本身是正确的（不需要 useShallow）。

### T-5 — Committer `notifyScheduled` 注释

保持现状，加注释 "callback may fire after destroy; listeners already cleared so no-op."

### T 组不变式

| ID | 断言 |
|---|---|
| I-T1 | 删除的 action 名在 grep 全仓库中 0 引用 |
| I-T2 | turnDone 调用时 assistant-header 已存在，不触发 fallback |
| I-T3 | useLiveItem 不绕过 zustand subscribe |

---

## 5. Group M — Sub-Agent M3 Follow-up

### M-1 — `concurrentByTurn` counter 防泄漏

**Root cause**: runner-spawner.ts:64-83: `resolveModel` / `bus.emit` 在 try/finally release 之外。

`Decision M-1.a`: 单层 try/finally 包住 tryAcquire 之后所有代码。

```ts
if (!tryAcquire(input.parentTurnId)) return '<sub-agent-error type="busy" ... />'
try {
  // resolveModel, bus.emit.started, spawner.run, bus.emit.completed
} finally {
  release(input.parentTurnId)
}
```

### M-2 — Dataplane sub-agent.* DP 事件（删除）

**决策**: 删 dataplane 的 3 个映射 + DataPlaneEventType 的 3 个 type。
M3 widget 已经是唯一对外契约，DP 暴露面应收紧。

### M-3 — SubAgentErrorType 全量保留 + runner 映射 + warn 状态

**Decision M-3.a**: 保留全量 13 个枚举（不缩到 3 个）。
**Decision M-3.b**: xml type 与 enum 命名一致。
**Decision M-3.c**: 仅 `stop` 算 ok=true，其余 ok=false。
**Decision M-3.d**: `busy` / `unknown_type` 早返回时补 emit started+completed 一对。
**Decision M-3.e**: xml type 重命名：`unknown_subagent_type`→`unknown_type`，`max_rounds_reached`→`max_rounds`，`budget_exhausted`→`budget`，`empty_rounds` warning→error `empty_response`。
**Decision M-3.f**: enum 字面量不动（13 项保持原名，只动 xml type）。
**Decision M-3.g**: ERROR_LABELS 放 widget-subagent-task.tsx 内，局部自治。

**新增 M-3.h — warn 状态** (grilling Q3):
引入第三视觉状态 `warn`（黄色），区分"非正常结束但有输出可用"与"完全失败"。

`SubAgentTaskPayload.status` 扩展为：`'running' | 'ok' | 'warn' | 'failed' | 'cancelled'`

widget-bridge.ts 映射函数：
```ts
function mapToWidgetStatus(ok: boolean, errorType?: SubAgentErrorType, hasFinalText?: boolean) {
  if (ok) return 'ok'
  if (errorType === 'cancelled') return 'cancelled'
  const PARTIAL_USABLE = new Set(['budget', 'max_rounds', 'length', 'empty_response'])
  if (errorType && PARTIAL_USABLE.has(errorType) && hasFinalText) return 'warn'
  return 'failed'
}
```

ERROR_LABELS 加 severity 字段：
```ts
const ERROR_LABELS: Record<SubAgentErrorType, { label: string; severity: 'warn' | 'error' }> = {
  cancelled:      { label: 'Cancelled',            severity: 'warn' },
  failed:         { label: 'Failed',               severity: 'error' },
  busy:           { label: 'Too many concurrent',  severity: 'error' },
  unknown_type:   { label: 'Unknown type',         severity: 'error' },
  budget:         { label: 'Budget exhausted',     severity: 'warn' },
  max_rounds:     { label: 'Max rounds reached',   severity: 'warn' },
  length:         { label: 'Output truncated',     severity: 'warn' },
  empty_response: { label: 'Empty response',       severity: 'warn' },
  content_filter: { label: 'Content filtered',     severity: 'error' },
  tool_unavailable:{ label: 'Tool not allowed',    severity: 'error' },
  tool_failed:    { label: 'Tool failed',          severity: 'error' },
  provider_inconsistent:{ label: 'Provider inconsistent', severity: 'error' },
  llm_failed:     { label: 'LLM failed',           severity: 'error' },
}
```

**M-3.d 澄清** (grilling Q2): busy/unknown_type 早返回 emit started+completed 时，同 blockId + replace 机制保证 widget merge 为单 block，不存在可见闪烁。加 I-M3g 不变式。

**LOC**: ~190（原 120 + 70 warn/labels）

**不变式**:
- I-M3a: SubAgentErrorType 保留 13 个值
- I-M3b: finishReason='length' → ok=false, errorType='response_truncated'
- I-M3c: busy 早返回也 emit started+completed 一对
- I-M3d: unknown_type 早返回也 emit started+completed
- I-M3e: xml type 无 `unknown_subagent_type` 字串
- I-M3f: ERROR_LABELS 13 项齐全
- I-M3g: early-return paths emit pair MUST share same callId for widget-bridge merge
- I-M3h: ok=false + errorType∈{budget,max_rounds,length,empty_response} + hasFinalText → widget status='warn' (yellow)

### M-4 — `isEmpty` 优先级遮蔽 `provider_inconsistent`

**Root cause**: mini-turn-loop.ts:154-155: isEmpty 包含 `finishReason === 'tool_calls'` 分支，拦截了 `handleNoToolCallsResponse` 的 `case 'tool_calls'` 分支。

**Decision M-4.a**: 收窄 isEmpty 条件，去掉 `|| resp.finishReason === 'tool_calls'`（单行改动）。

```ts
// Before
const isEmpty = !resp.content && (!resp.toolCalls || resp.toolCalls.length === 0)
  && (resp.finishReason === 'stop' || resp.finishReason === 'tool_calls')

// After
const isEmpty = !resp.content && (!resp.toolCalls || resp.toolCalls.length === 0)
  && resp.finishReason === 'stop'
```

`handleNoToolCallsResponse` 的 `case 'tool_calls'` 分支保留（defense in depth）。

**注**: U-1.b 顺手修 `done.finishReason` 透传也是 M-4 的远端根因修复——turn-runner 不再用推断伪造 finishReason。

### M-5 — Widget-bridge dispose 顺序

**修法**: `clearInterval(sweepTimer)` 移到 `offStarted/offProgress/offCompleted` 之前（一行调换）。

### M-6 — 死注释 + 死分支清理

| 项 | 处理 |
|---|---|
| runner-spawner.ts:101 `req.model ?? model` | 加注释 |
| registry.ts:55 plan agent prompt | 删 "Do NOT call todo_write" |
| handleNoToolCallsResponse case 'tool_calls' | M-4 后 defense in depth，保留加注释 |

### M 组不变式

| ID | 断言 |
|---|---|
| I-M1 | resolveModel 抛 → concurrentByTurn 计数清零 |
| I-M2 | dataplane 不 emit sub-agent.* 事件 |
| I-M3a~h | SubAgentErrorType + warn + emit 对 |
| I-M4 | finishReason='tool_calls'+空 toolCalls → handleNoToolCallsResponse 命中 case 'tool_calls' |
| I-M5 | widget-bridge dispose 后 sweep timer 已停 |

---

## 6. 实施顺序与 PR 切分

| PR | 内容 | LOC | 依赖 |
|---|---|---|---|
| **PR-1** | Group U (token usage 全链) | ~110 | 独立 |
| **PR-2** | D-1 + D-2 (permission/ask-user-question 接线) | ~150 | 独立 |
| **PR-3** | W-1 (mode badge) + W-3 (/clear divider + 竞态) + W-5 + T-1 | ~250 | 独立 |
| **PR-4** | W-2 (todo prompt) + W-4 (review deletion) + T-2 + T-3 + T-5 | ~80 | 独立 |
| **PR-5** | M-1 + M-3 (errorType + warn) + M-4 (isEmpty) + M-5 + M-6 | ~190 | 独立 |
| **PR-6** | D-3 + M-2 (subagent 死代码删除) | ~100 | 在 PR-5 之后 |
| **PR-7** | 测试补齐（各组不变式覆盖） | ~274 | 在各 PR 之后（或随 PR 出） |

**推荐顺序**:
1. PR-1 + PR-2 + PR-5 并行（P0，互不冲突）
2. PR-3 + PR-4 并行（独立小修）
3. PR-6（等 PR-5 落地，避免 merge conflict）
4. PR-7（随各 PR 出测试，或在最后统一补齐）

**总计**: 7 个 PR，~1154 LOC

---

## 7. 决策点速查表（共 37 个）

| ID | 决策 | 选择 |
|---|---|---|
| U-1.a | adapter 返回格式 | `ChatResponseChunk[] \| null` |
| U-1.b | done chunk 加 finishReason | 是，顺手修 M-4 根因 |
| U-2.a | Claude usage 累积位置 | provider 层闭包 |
| U-2.c | Claude usage emit 时机 | message_stop 一次性 |
| U-4.a | accumulateUsage 重构 | 拆 setPromptTokens + accumulateCompletionTokens |
| U-5.a | contextTokens 来源 | = lastTurnInputTokens |
| D-1.a | permission 接线位置 | use-agent-subscription case body |
| D-1.b | permission resolve 回路 | controlplane RPC `permission.resolve` |
| D-1.c | permission pending 数据结构 | FIFO 队列 |
| D-2.a | ask-user-question RPC | 复用 `user.answer` |
| D-3.a | subagent in-process 死线 | 全删 |
| W-1.a | mode 映射归属 | dataplane builtInMappings |
| W-1.b | snapshot/reconnect 路径 | RPC `session.getMode` |
| W-2.a | widget 持久化 | prompt-only（不持久化，不 derive） |
| W-3.a | /clear 语义 | 对齐 Claude: scrollback 保留 + history 清 + divider |
| W-3.b | divider 呈现位置 | store.finalized push，FinalItemView 渲染 |
| W-3.c | clearTranscript 实现 | 删除 hook + 加 waitDrained 竞态修复 |
| W-3.d | stats 重置触发源 | server emit `session.cleared` → dataplane → resetStats |
| W-4.a | review notification | 全删（-96 LOC） |
| W-5.a | store.todos | 删 |
| T-2.a | turnDone fallback | 删 |
| T-3.a | useLiveItem 重写 | `useTuiStore(s => s.live)` 朴素 |
| T-5.a | committer destroy | 现状 + 注释 |
| M-1.a | try/finally | 单层 |
| M-2.a | dataplane sub-agent.* | 全删 |
| M-3.a | SubAgentErrorType | 保留全量 13 项 |
| M-3.b | xml type vs enum 命名 | 一致 |
| M-3.c | finishReason → ok 判定 | 仅 `stop` 为 true |
| M-3.d | busy/unknown_type 早返回 | 补 emit started+completed 一对 |
| M-3.e | xml type 重命名 | 4 处改名 |
| M-3.f | enum 字面量 | 不动 |
| M-3.g | ERROR_LABELS 位置 | widget-subagent-task.tsx |
| M-3.h | warn 状态 | 引入（yellow），区分 partial-usable vs 完全失败 |
| M-4.a | isEmpty 收窄 | 去 `tool_calls` 分支 |
| M-5.a | dispose 顺序 | clearInterval 最先 |
| W-3.waitDrained | timeout 默认值 | 2000ms |

---

## 8. 文件清单

### 新增
```
tests/infrastructure/llm/openai-adapter-usage.test.ts        ~80 LOC
tests/infrastructure/llm/claude-provider-usage.test.ts       ~100 LOC
tests/extensions/frontend.tui/hooks/use-agent-subscription.test.ts  ~200 LOC
tests/extensions/frontend.tui/state/store-usage.test.ts      ~80 LOC
tests/extensions/frontend.tui/App-clear.test.tsx             ~50 LOC
tests/application/slash/slash-clear-divider.test.ts          ~60 LOC
tests/unit/sub-agent/runner-spawner-error-mapping.test.ts    ~120 LOC
tests/extensions/frontend.tui/widgets/widget-subagent-task-labels.test.tsx  ~60 LOC
```

### 修改
```
application/ports/provider-adapter.ts                        fromChatStreamChunk → ChatResponseChunk[] | null
application/ports/provider.ts                                done chunk + finishReason
application/contracts/dataplane-event.ts                     + session.mode-changed / + session.cleared / - 4 个
application/contracts/subagent-events.ts                     JSDoc 标注 + finalText 在错误路径透传
infrastructure/llm/openai-provider.ts                        for-of 适配数组
infrastructure/llm/claude-provider.ts                        闭包累积 usage + for-of
infrastructure/llm/adapters/openai-adapter.ts                response.completed emit usage + done.finishReason
infrastructure/llm/adapters/claude-adapter.ts                message_start/delta/stop 拆解 + done.finishReason
infrastructure/llm/echo-provider.ts                          done finishReason: 'stop'
domain/turn-runner.ts                                        用 chunk.finishReason 替代推断
extensions/session/index.ts                                  usage 不再 ?? null + waitDrained 能力
extensions/session-mode/index.ts                             RPC session.getMode
extensions/dataplane/index.ts                                + session.mode-changed / + session.cleared / - 3 个 sub-agent.*
extensions/permission/index.ts                               (无变更，RPC 已存在)
extensions/sub-agent/runner-spawner.ts                       M-1 try/finally + M-3 full errorType + M-3.d emit pairs + xml rename
extensions/sub-agent/mini-turn-loop.ts                       M-4 收窄 isEmpty + xml rename + empty_rounds→error
extensions/sub-agent/widget-bridge.ts                        M-3.h warn 映射 + M-5 dispose 顺序
extensions/sub-agent/registry.ts                             删 plan agent 冗余 prompt
extensions/controlplane/rpc-handlers.ts                      session.clear 加 waitDrained
tools/index.ts                                               TODO_WRITE_GUIDANCE 重写
frontend.lark/internal/data-plane-to-agent-event.ts          删 sub-agent.* + evolution.skillProposed case
frontend.tui/transcript/types.ts                             + mode_changed / + session_cleared / + user_question_requested / - subagent_*
frontend.tui/transcript/from-dataplane.ts                    + 5 个 case / 确认 dead events 掉入 default→null
frontend.tui/state/types.ts                                  - subagent-block / - ReviewNotification / StatsState 字段更名
frontend.tui/state/store.ts                                  action 增删改 + resetStats action + FIFO 队列
frontend.tui/state/selectors.ts                              useLiveItem 简化
frontend.tui/hooks/use-agent-subscription.ts                 permission/ask-user-question/mode_changed/session_cleared/usage
frontend.tui/overlays/use-permission-manager.ts              单例 → FIFO 队列
frontend.tui/overlays/use-ask-user-question-manager.ts       单例 → FIFO 队列
frontend.tui/widgets/widget-subagent-task.tsx                ERROR_LABELS + warn 状态渲染
frontend.tui/views/chrome/Footer.tsx                         读 lastTurnInputTokens
frontend.tui/views/final/FinalItemView.tsx                   删 subagent-block case + 确认 divider case
frontend.tui/streaming/committer.ts                          destroy 注释
frontend.tui/App.tsx                                         删 clearTranscript + 删 OverlayReviewNotification + appendDivider + getMode
frontend.tui/index.ts                                        getMode 初始化调用
application/slash/builtin/slash-clear.ts                     改 appendDivider('clear')
application/slash/builtin/slash-compact.ts                   加 appendDivider('compact')
```

### 删除
```
frontend.tui/overlays/impls/overlay-review-notification.tsx  (整个文件)
```

---

## 9. Edge Cases

| Case | 行为 |
|---|---|
| OpenAI stream 异常断开（无 response.completed） | usage 未发，Footer 显示上一轮 ctx，无 crash |
| Claude stream 在 message_start 后立刻断 | pendingUsage 闭包随 generator 结束被 GC |
| Permission request 用户 30s 不响应 | permission ext timeout 主导 deny，TUI 不主动超时 |
| /clear 时 streaming 中 | committer.onTurnDone() flush → waitDrained → history.clear → divider |
| Mode badge 显示 'normal' | 不渲染（Header `mode !== 'normal'` 条件） |
| /clear 后立即 /clear | 两条 divider 紧贴，可接受 |
| 并发 2 个 permission request | FIFO 队列，逐个 prompt，overlay 标题显示 "1/N pending" |
| busy/unknown_type 早返回补 emit | 同 blockId replace 合并，无视觉闪烁 |
| widget-bridge dispose 后 sweep timer | clearInterval 先于 unsub，callback 不触发 emit |

---

## 10. 显式不在本 spec 范围

- TUI 视觉/排版重设计
- 新 widget 类型添加
- session.modeChanged 之外的其他 mode 系统改造
- compaction strategy 改进
- 多 frontend 并发 attach 的协同
- Permission "always" 持久化（permission ext 已提供，UI 只透传）
- token 估算的精确化
- TUI 性能优化

---

## 11. 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| U-1/U-2 adapter 接口签名改破坏第三方 adapter | 低（仓库内只有 2 个） | 编译错误 | tsc 强校验 |
| W-3 waitDrained 超时 | 低 | /clear 返回延迟 ≤2s | timeout 2000ms 兜底 |
| D-1.c 队列化改 UX | 低 | 用户看 "1/N pending" | overlay 标题提示 |
| M-3 xml type 改名 | 极低 | LLM 小概率行为漂移 | LLM 用 reason 属性理解，不记 type 字串 |
| M-3.d busy emit 增 | 低 | frontend 出现新 failure block | widget 失败态已有渲染 |
| W-2 prompt-only | 低 | 模型不重发 todo | 新 prompt 显式要求 resume re-send |
