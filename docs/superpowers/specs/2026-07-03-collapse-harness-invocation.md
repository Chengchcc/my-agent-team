# Spec: 塌缩 harness 调用层 (v5 — SessionManager + ctx.span + HookContext\<Ctx\> + setData)

## 目标

删除 `SessionFactory` / `SessionSpec` / `span-executor.ts` / `session-factory.ts` / `deriveSessionId` / `parseSessionId` / `buildAgentConfig`。
引入 `SessionManager`：身份与持久化自洽，caller 不碰 sessionId 也不碰 checkpointer。
引入 `ctx.span`（OTel 式）：run 追踪归 framework 自动管理。
引入 `HookContext<Ctx>` + `AgentSession.setData()`：per-run 数据通过泛型在各层保持类型安全。
技术概念下压，业务概念上浮。各 feature 在自己的领域表里持久化 sessionId 绑定。

依据：[ADR 0009](../../adr/0009-session-layer-owns-identity-features-own-binding.md)

## 分层职责

```
core / run()             — 运行时引擎。

framework / Agent        — ctx.span 自动 start/end。spanId 自动生成。
                           ctx 携带 data?: Ctx（泛型），透传不解析。

harness / AgentSession   — 拥有身份和记忆。setData(value) 在 prompt 前写 per-run 数据，
                           内部 buffer → agent.run(opts.data) → ctx.data。
                           SessionConfig 是 caller 可见的公开接口。

backend / SessionManager — create/open/get/dispose。统一注入 startSpan。

backend / SpanSupervisor — startSpan(spanId, sessionId, opts?) 返回 RunSpan。

conversation/cron/orch   — session create/open、subscribe、prompt。
                           不碰 opsStore/startMainRun/crypto。
```

## 设计决策

1. **sessionId = ULID**，SessionManager 生成，不编码领域语义
2. **spanId 自动生成**：prompt opts 不传则 framework 自动 `crypto.randomUUID()`
3. **checkpointer 是 SessionManager 内部实现**，config 类型 `SessionConfig`（不含 sessionId/checkpointer/startSpan）
4. **ctx.span**：framework `run()` finally 自动 `ctx.span?.end()`
5. **origin 上浮**：`prompt(opts.origin)` → framework 透传给 `startSpan` → supervisor 内部写 `insertSpanOrigin`
6. **per-run 上下文上浮**：`AgentSession.setData(value)` → `agent.run(opts.data)` → `ctx.data`。`HookContext<Ctx>` 泛型保证 plugin 侧 `ctx.data` 直接收窄到具体类型，不需要 `as` 断言
7. **RunSpan 接口在 framework**，supervisor 实现 `startSpan()` → RunSpan，`span.end()` 内部调 `notifyRunComplete`
8. **不需要 tracePlugin、afterRun hook**
9. **member 表加 `session_id` 字段**
10. **sessionManager.create/open 统一注入 startSpan**，feature 不传
11. **resume**：`spanId → run.session_id → sessionManager.get(sid) → session.resume()`
12. **traceId/traceparent 列删除**
13. **todo_update 事件加 spanId**
14. **session-factory.ts 整个删除**，`buildAgentConfig` 删除，换 `agent-helpers.ts` 纯函数（createModel/defaultTools/convTools/defaultPlugins/conversationPlugins/defaultContextManager）

## 关键接口

### framework

```typescript
// HookContext<Ctx> — 泛型化 per-run context
export interface HookContext<Ctx = Record<string, unknown>> {
  sessionId: string;
  span?: RunSpan;
  data?: Ctx;                   // ← per-run 数据，plugin 读 ctx.data 类型自动收窄
  // ...
}
```

### harness

```typescript
// SessionConfig — caller 传的公开接口
export interface SessionConfig {
  model: ChatModel;
  tools?: Tool[];
  plugins?: Plugin[];
  contextManager?: ContextManager;
  systemPrompt?: string;
}

// AgentSession<Ctx> — 泛型化
class AgentSession<Ctx = Record<string, unknown>> {
  setData(value: Ctx): void;    // ← 替代 prompt(opts.context)
  // ...
}
```

### 数据流

```
feature: session.setData({ id, surface, senderName, input })
  → AgentSession.#data = value
  → prompt() → agent.run(input, { data: this.#data })
  → create-agent run(): ctx.data = opts.data
  → plugin: ctx.data → 自动收窄到 ConversationContext
```

## 删除清单（已全部完成）

| 文件 | 状态 |
|------|------|
| `session-factory.ts` | DELETED |
| `session-factory.test.ts` | DELETED |
| `span-executor.ts` | DELETED |
| `span-executor.test.ts` | DELETED |
| `agent-config.ts`（原 buildAgentConfig） | DELETED |
| `service.ts#parseSessionId` | DELETED |
| `service.ts#deriveSessionId` | DELETED |
| `schema.ts#span_origin.traceId` | DELETED |
| `schema.ts#span_origin.traceparent` | DELETED |
| `mock-deps.ts#FakeSessionFactory` | DELETED |
| `mock-deps.ts#makeRunDeps` | DELETED |
| `AgentSessionConfig` 导出 | DELETED（仅内部使用） |

## 新增清单

| 文件 | 内容 |
|------|------|
| `packages/framework/src/trace.ts` | RunSpan 接口 |
| `span/session-manager.ts` | SessionManager + SqliteSessionManager |
| `span/session-manager.test.ts` | 单测 |
| `span/agent-helpers.ts` | createModel/defaultTools/convTools/defaultPlugins/conversationPlugins/defaultContextManager |
| `schema.ts#member.session_id` | 字段 |

## 不做的

- `OWNER_MEMBER_ID` 保留
- `ModelFactory` 移到 `title.ts` 内联
- cron 不复用 session
- `afterRun` hook 不加
- tracePlugin 不做
- `conversation_session` 独立表不做
- `context` 不做 symbol-key——用 `HookContext<Ctx>` 泛型方案

## 验收

```bash
bun run typecheck  # 0 errors
bun run test       # 340 pass / 0 fail
```
