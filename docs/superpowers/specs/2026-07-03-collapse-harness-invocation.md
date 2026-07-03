# Spec: 塌缩 harness 调用层

## 目标

删除 `SessionFactory` / `SessionSpec` / `span-executor.ts` / `session-factory.ts`。
所有 feature 走同一条直接路径: `new AgentSession(config)` → `session.prompt(input)` → `session.dispose()`。

## 设计决策

1. **sessionId = ULID**, AgentSession 构造函数接收或自生成，不编码领域语义
2. **spanId = tracePlugin 生成**, 不泄漏给 caller
3. **traceId 列删除**, 无 OTel 集成，用 spanId 承担 trace 责任
4. **conversation_session 表**: `(conversationId, agentMemberId) → sessionId`，替代 `parseSessionId`
5. **supervisor reaper**: 收 `Map<string, AgentSession>`，dispose idle sessions
6. **resume**: `spanId → DB 查 sessionId → Map.get(sid) → session.resume()`
7. **tracePlugin 暂为 wrapper**(hooks 不支持 onEvent)，后续 plugin infra 升级后再迁

## 删除清单

| 文件 | 内容 |
|------|------|
| `session-factory.ts` | SessionFactory , SessionSpec, buildSessionSpec, SessionSpecMismatchError |
| `session-factory.test.ts` | 13 tests |
| `span-executor.ts` | executeAgentRun, makeRunDeps, RunDeps, RunRequest, SpanOrigin |
| `span-executor.test.ts` | executeAgentRun tests |
| `mock-deps.ts#FakeSessionFactory` | lines 338-391 |
| `mock-deps.ts#makeRunDeps` | line 468 (unused) |
| `service.ts#parseSessionId` | line 36 |
| `service.ts#deriveSessionId` | line 23 |
| `schema.ts#span_origin.traceId` | column |
| `schema.ts#span_origin.traceparent` | column |

## 新增清单

| 文件 | 内容 |
|------|------|
| `packages/plugin-trace/src/index.ts` | tracePlugin (wrapper 模式) |
| `schema.ts#conversation_session` | `(conversationId, agentMemberId, sessionId)` |

## 文件变更

| 文件 | 变更 |
|------|------|
| `main.ts` | 删 sessionFactory, 加 sessionMap, 更新所有 wiring |
| `conversation-compose.ts` | startAgentRun: 直接 new AgentSession + subscribe(events) |
| `conversation/run-accumulator.ts` | onRunComplete: 从 supervisor 拿 conversationId |
| `conversation/service.ts` | 删 parseSessionId/deriveSessionId, 保留 OWNER_MEMBER_ID |
| `cron/scheduler.ts` | fire/fireLoop: 直接 new AgentSession + prompt |
| `orchestrator/reactor.ts` | startStep: 直接 new AgentSession + prompt |
| `loop/http.ts` | 删 sessionFactory 入参 |
| `loop/loop-step.ts` | 删 sessionFactory, buildSpec → AgentSessionConfig |
| `span/http.ts` | resumeRoutes: factory.peek → Map.get |
| `skill-pack/install-session.ts` | 删 sessionFactory import |
| `test-helpers/mock-deps.ts` | 删 FakeSessionFactory, 加 fakeSessionMap |
