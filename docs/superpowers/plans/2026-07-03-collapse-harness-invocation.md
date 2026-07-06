# Plan: 塌缩 harness 调用层 (v4 — SessionManager + ctx.span + 业务上浮)

依据：[Spec v4](../specs/2026-07-03-collapse-harness-invocation.md) · [ADR 0009](../../adr/0009-session-layer-owns-identity-features-own-binding.md)

## 风险清单

### R1: sessionId 拼接泄漏——orchestrator + cron + issue service

**现状**：三处用确定性拼接生成 sessionId，spec 要全删但它们散在不同层。

| 位置 | 拼接 | 用途 |
|------|------|------|
| `conversation/service.ts:23` | `${conversationId}:${memberId}` | conversation 复用 |
| `orchestrator/reactor.ts:94` | `${issue.issueId}:${t.agentId}` | orchestrator 每次 run |
| `cron/scheduler.ts:64` | `${job.cronJobId}:${job.agentId}` | cron 每次 run |
| `issue/service.ts:75` | `${issueId}:${OWNER_MEMBER_ID}` | issue 表的 sessionId 字段 |

**处理**：
- conversation → `member.session_id` 字段替代（Step 4）
- orchestrator → 每次新 ULID，run 表已存 session_id（Step 9b）
- cron → 每次新 ULID，不复用（Step 9a）
- issue service → **`issue.sessionId` 字段保留**，但语义变为「issue 侧 conversation 的 owner session 绑定」。`createIssue` 时不再拼 `${issueId}:owner`，改为创建 conversation 时由 conversation feature 写 `member.session_id`。issue 表的 `sessionId` 字段标记为 deprecated，后续迁移

### R2: issue.service.test.ts 断言 sessionId 拼接

**现状**：`service.test.ts:28` 断言 `issue.sessionId === "test-iss-0:owner"`，`service.test.ts:36` 同理。

**处理**：Step 8 迁移 issue service 时同步改测试。issue 不再拼 sessionId，改为创建 conversation + member 后由 conversation 写 session_id。测试断言改为检查 conversation member 的 session_id 非空。

### R3: orchestrator reactor.test.ts 断言 sessionId 拼接

**现状**：`reactor.test.ts:80` 断言 `supervisor.startedRuns[0].sessionId === TID.issueSession(planned.issueId, "planner")`。`TID.issueSession` 返回 `${issue}:${agent}`。

**处理**：Step 9b 迁移时改测试——`recordingSupervisor` 的 `startSpan` 不再接收 sessionId 参数（sessionId 由 SessionManager 内部生成）。测试改为断言 `startedRuns[0].spanId` 非空 + `startedRuns[0].origin.issueId` 匹配。`recordingSupervisor` mock 需改造。

### R4: recordingSupervisor mock 签名变化

**现状**：`recordingSupervisor().startMainRun(spanId, sessionId, spec)` 记录三元组。`notifyRunComplete(spanId, status)` 两参数。

**处理**：Step 3 改造 supervisor 时同步改 mock：
- `startMainRun` → `startSpan(spanId, sessionId, origin?)` 返回 RunSpan
- mock 返回 `{ spanId, sessionId, end: () => {} }`
- `recordingSupervisor.startedRuns` 记录 `{ spanId, sessionId, origin }`

### R5: mock-deps.ts FakeSessionFactory + makeRunDeps 被多处测试引用

**现状**：`fakeSessionFactory` 被 `http.test.ts` 引用。`makeRunDeps` 被 `span-executor.test.ts` 引用（但 span-executor 整个删掉）。

**处理**：
- Step 6 删 `span-executor.ts` + `span-executor.test.ts` + `makeRunDeps`
- Step 5 改 `http.test.ts` 用 `fakeSessionManager` 替代 `fakeSessionFactory`
- `fakeSessionFactory` 删除，新增 `fakeSessionManager`

### R6: conversationContextPlugin 接口变化——systemPrompt 删除

**现状**：`conversationContextPlugin({ tools, systemPrompt })` — systemPrompt 是必填参数。改为 ctx-based 后删 systemPrompt。

**处理**：Step 5 改 plugin + 测试。plugin 的 `beforeModel` 从 `ctx.conversation` 读。测试需要传 `ctx.conversation` —— 但 `createAgent` 的测试如何设 ctx.conversation？通过 `prompt(opts.conversation)` 传入，framework 挂到 ctx。

**风险**：plugin 测试用 `createAgent` + `agent.run("hi")` — 需要改为 `agent.run("hi", { conversation: { id: "c1", surface: "web", senderName: "test", input: "hi" } })`。

### R7: supervisor.notifyRunComplete 被 runtime-ops/service.ts 直接调用

**现状**：`runtime-ops/service.ts:230` 直接调 `supervisor.notifyRunComplete(run.sessionId, spanId, "interrupted", run.kind)` 标记心跳超时的 run 为 interrupted。

**处理**：`notifyRunComplete` 移入 `span.end()` 后，这个调用点需要改为通过 `supervisor.getActive().get(spanId)` 拿到 RunSpan 再调 `.end("interrupted")`。但 RunSpan 存在 supervisor 的 `#active` Map 里——需要在 `startSpan` 时把 RunSpan 也存进 `#active`，或暴露 `getSpan(spanId)` 方法。

### R8: supervisor.onRunComplete 回调签名含 sessionId

**现状**：回调签名 `(sessionId, spanId, status, kind, errorMessage?)`。三处注册：
- `main.ts:174` — conversation onRunComplete（用 sessionId 调 `onRunComplete(sessionId, ...)`）
- `main.ts:328` — orchestrator onRunComplete（`_sessionId` 忽略）
- `cron/scheduler.ts:188` — `_sessionId` 忽略

**处理**：保留 supervisor 回调签名不变（`sessionId` 仍从 run 表查得到）。但 conversation 的 `onRunComplete` 函数签名删 `sessionId` 参数——main.ts 注册时忽略回调的第一个参数即可。orchestrator/cron 已经忽略。

### R9: completeRun 签名含 sessionId

**现状**：`convSvc.completeRun(cid, sessionId, spanId)` — `service.ts:444` 的 `completeRun(conversationId, _sessionId, _runId)` 忽略 sessionId。

**处理**：删 `sessionId` 参数：`completeRun(conversationId, spanId)`。`run-accumulator.ts:202` 同步改。`service.test.ts:346` 同步改。

### R10: span-executor.test.ts 用 makeRunDeps + executeAgentRun 做集成测试

**现状**：`span-executor.test.ts` 测试 `executeAgentRun` 的 completion signal——supervisor.onRunComplete 是否被调用。这是唯一测试「session 事件 → supervisor notify」链路的集成测试。

**处理**：span-executor 删掉后，这个链路由 framework 的 `ctx.span.end()` 自动调 `notifyRunComplete` 覆盖。需要新写一个 `session-manager.test.ts` 的集成测试：create session + prompt + 等 agent_end → 验证 supervisor.startSpan 被调 + span.end 被调 + onRunComplete 触发。

### R11: install-session.ts 直接 new AgentSession

**现状**：`install-session.ts:70` 直接 `new AgentSession({ sessionId, model, ... })`，不用 SessionFactory。

**处理**：改为 `sessionManager.create(config)`。但 install-session 不需要追踪（无 supervisor）——`startSpan` 不传即可，ctx.span=undefined，不影响行为。install-session 需要接收 SessionManager 作为依赖注入。

### R12: ModelFactory 类型定义在 session-factory.ts

**现状**：`ModelFactory` 定义在 `session-factory.ts:77`，被 `title.ts:3` 和 `span-executor.ts:10` 引用。session-factory.ts 整个删掉。

**处理**：`ModelFactory` 类型移到 `title.ts` 内联定义（只有一个外部使用者 title.ts）。spec 已说明。

### R13: buildSessionSpec 的 conversation 上下文参数删除后 convTools 怎么办

**现状**：`buildSessionSpec` 接收 `convPort` + `conversationId` 创建 `convTools`（read_conversation_history 等），这些工具需要 conversationId 闭包。同时用 conversationId/surface/senderName/input 拼 systemPrompt 传给 `conversationContextPlugin`。

**处理**：
- `convTools` 仍然需要 conversationId 闭包——`buildAgentConfig` 保留 `convPort` + `conversationId` 参数（工具闭包依赖）
- `conversationContextPlugin` 的 systemPrompt 删掉（改 ctx-based）
- `buildAgentConfig` 删掉 `surface`/`senderName`/`input` 参数

### R14: conversationContextPlugin 的 beforeModel 在非 conversation 场景

**现状**：cron/orchestrator 的 session 不含 conversationContextPlugin，ctx.conversation=undefined。plugin 的 beforeModel 需要处理 `ctx.conversation` 为 undefined 的情况。

**处理**：plugin 的 `beforeModel` 检查 `ctx.conversation` — falsy 时直接 `return messages`。已在 spec 伪代码中体现。

### R15: run-accumulator.test.ts 用 sessionId 调 onRunComplete

**现状**：`run-accumulator.test.ts:68` 调 `onRunComplete(sessionId, "r-p3-lock", "succeeded", failingPort, svc, fakeOpsStore)`。sessionId 用于 `parseSessionId` 拿 conversationId。

**处理**：`onRunComplete` 签名删 sessionId 后，测试需要改用 `opsStore.getSpanOrigin` 返回 conversationId。测试的 `fakeOpsStore` mock 需要支持 `getSpanOrigin(spanId)` 返回 `{ conversationId: cid, agentMemberId: "agent-1" }`。

### R16: loop-step.ts 的 tallyUsage 读 spec

**现状**：`loop-step.ts:272` 调 `tallyUsage(genSpec, genSessionId)` — 传 SessionSpec 和 sessionId。

**处理**：`tallyUsage` 的签名需要改——SessionSpec 删掉后传 `AgentSession`（从 session 对象读 usage）。或直接从 `session` 对象读 usage。

## 执行顺序

### Phase 0: framework — RunSpan + ctx.span + ctx.conversation（纯新增 + 改 finally）

**文件**：
- `packages/framework/src/trace.ts` — 新增 RunSpan 接口
- `packages/framework/src/plugin.ts` — HookContext 加 `span?` + `conversation?`
- `packages/harness/src/agent-session.ts` — AgentSessionConfig 加 `startSpan?`；PromptOptions 加 `origin?`/`conversation?`；`spanId` 改可选
- `packages/framework/src/agent-event.ts` — todo_update 加 `spanId?`
- `packages/plugin-task-guard/src/task-guard.ts` — emit todo_update 时带 `ctx.span?.spanId`
- `packages/framework/src/create-agent.ts` — run/continue/resume：spanId 自动生成 + ctx.span 创建/end + ctx.conversation 挂载/清理

**验证**：`bun test packages/framework/ packages/plugin-task-guard/` 全绿（startSpan/conversation 未传时 undefined，不影响现有行为）

**风险**：R6（plugin 测试需改 prompt 调用方式传 conversation）— 但此 phase 只加可选字段，不删 systemPrompt，所以 conversationContextPlugin 测试不受影响。systemPrompt 删除在 Phase 5。

---

### Phase 1: SessionManager（纯新增 TDD）

**文件**：
- `apps/backend/src/features/span/session-manager.ts` — SessionManager 接口 + SqliteSessionManager
- `apps/backend/src/features/span/session-manager.test.ts` — 单测

**验证**：`bun test span/session-manager.test.ts`

**测试覆盖**：
- create() 生成 ULID + new AgentSession + 内存注册
- open(sid) 内存命中返回现存
- open(sid) 内存未命中 new AgentSession
- get(sid) 只取不创建
- dispose(sid) 清理
- startSpan 统一注入（supervisor.startSpan 被调）

---

### Phase 2: supervisor.startSpan（改造）

**文件**：
- `apps/backend/src/features/span/supervisor.ts` — startMainRun → startSpan，返回 RunSpan；insertSpanOrigin 移入；notifyRunComplete 移入 span.end()
- `apps/backend/src/features/span/supervisor.test.ts` — 改测试调用方式
- `apps/backend/test-helpers/mock-deps.ts` — recordingSupervisor 改 mock（R4）

**验证**：`bun test span/supervisor.test.ts`

**风险**：R4（mock 签名变化）、R7（runtime-ops/service.ts 直接调 notifyRunComplete）— R7 在此 phase 需要同步改 service.ts:230，改为通过 supervisor 暴露的方法调 span.end()。

---

### Phase 3: member 表加 session_id + adapter

**文件**：
- `apps/backend/src/infra/db/schema.ts` — member 加 session_id TEXT
- `drizzle generate`
- `apps/backend/src/features/conversation/adapter-sqlite.ts` — 加 getMemberSessionId / updateMemberSessionId
- `apps/backend/src/features/conversation/ports.ts` — 加接口
- `apps/backend/src/features/conversation/adapter-sqlite.test.ts` — 加测试

**验证**：`bun test conversation/adapter-sqlite.test.ts`

---

### Phase 4: conversationContextPlugin 改为 ctx-based

**文件**：
- `packages/plugin-conversation-context/src/conversation-context-plugin.ts` — 删 systemPrompt，beforeModel 读 ctx.conversation
- `packages/plugin-conversation-context/src/conversation-context-plugin.test.ts` — 改测试（prompt 传 conversation）

**验证**：`bun test packages/plugin-conversation-context/`

**风险**：R6（测试需改 prompt 调用方式）、R14（非 conversation 场景 ctx.conversation=undefined）

---

### Phase 5: http.test.ts → http.ts（resume 路径 test-first）

**文件**：
- `apps/backend/test-helpers/mock-deps.ts` — fakeSessionFactory → fakeSessionManager（R5）
- `apps/backend/src/features/span/http.test.ts` — 改测试
- `apps/backend/src/features/span/http.ts` — sessionFactory.peek → sessionManager.get

**验证**：`bun test span/http.test.ts`

---

### Phase 6: loop-step.test.ts → loop-step.ts + loop/http.ts（test-first）

**文件**：
- `apps/backend/src/features/loop/loop-step.test.ts` — SessionFactory → SessionManager, SessionSpec → AgentSessionConfig
- `apps/backend/src/features/loop/loop-step.ts` — sessionManager.create + prompt + dispose
- `apps/backend/src/features/loop/http.ts` — sessionFactory → sessionManager, buildSpec → buildConfig

**验证**：`bun test features/loop/`

**风险**：R16（tallyUsage 签名改）

---

### Phase 7: conversation-compose + service + run-accumulator + buildAgentConfig

**文件**：
- `apps/backend/src/features/span/session-factory.ts` — buildSessionSpec → buildAgentConfig（删 conversation 上下文参数，返回类型变，R12/R13）
- `apps/backend/src/features/conversation/conversation-compose.ts` — startAgentRun 改造（sessionManager + prompt opts.origin/conversation）
- `apps/backend/src/features/conversation/service.ts` — 删 deriveSessionId/parseSessionId，startAgentRun 删 sessionId 参数
- `apps/backend/src/features/conversation/run-accumulator.ts` — onRunComplete 删 sessionId 参数（R8/R9/R15）
- `apps/backend/src/features/conversation/service.test.ts` — 改测试（R2/R9）
- `apps/backend/src/features/conversation/run-accumulator.test.ts` — 改测试（R15）
- `apps/backend/src/features/conversation/index.ts` — 删 parseSessionId re-export
- `apps/backend/src/features/conversation/title.ts` — ModelFactory 内联（R12）

**验证**：`bun run typecheck apps/backend/` + `bun test features/conversation/`

**风险**：R1（conversation sessionId 拼接删除）、R2（issue test 断言）、R8（onRunComplete 回调签名）、R9（completeRun 签名）、R12（ModelFactory）、R13（convTools 依赖 conversationId）、R15（run-accumulator test）

---

### Phase 8: 无测试 feature（typecheck 守卫）

**文件**：
- `apps/backend/src/features/cron/scheduler.ts` — sessionManager.create + prompt(opts.origin)（R1 cron）
- `apps/backend/src/features/orchestrator/reactor.ts` — sessionManager.create + prompt(opts.origin)（R1 orchestrator）
- `apps/backend/src/features/orchestrator/reactor.test.ts` — 改测试（R3）
- `apps/backend/src/features/issue/service.ts` — 删 sessionId 拼接（R1 issue）
- `apps/backend/src/features/issue/service.test.ts` — 改测试（R2）
- `apps/backend/src/features/skill-pack/install-session.ts` — sessionManager.create（R11）
- `apps/backend/src/main.ts` — 删 sessionFactory，加 sessionManager，更新 wiring（R8）

**验证**：每改一个 `bun run typecheck apps/backend/`

**风险**：R1（orchestrator/cron/issue sessionId）、R2（issue test）、R3（reactor test）、R7（runtime-ops notifyRunComplete）、R8（main.ts onRunComplete 注册）、R11（install-session）

---

### Phase 9: 清理 runtime-ops/service.ts traceId 依赖

**文件**：
- `apps/backend/src/features/runtime-ops/service.ts` — getRunDetail 删 traceId，getTraceDetail 删 traceId filter

**验证**：`bun test features/runtime-ops/`

---

### Phase 10: 清场（typecheck 当导游）

**操作**：
1. 删 `span-executor.ts` → typecheck 报 → 删 `span-executor.test.ts` + 删 mock-deps `makeRunDeps`（R5/R10）
2. 删 `session-factory.ts` → typecheck 报 → 删 `session-factory.test.ts` + 删 mock-deps `FakeSessionFactory`（R5）
3. 删 `service.ts` parseSessionId/deriveSessionId → typecheck 报 → 更新 barrel
4. 删 `schema.ts` traceId/traceparent → drizzle generate
5. 改 `runtime-ops/store.test.ts` + `issue/http.test.ts` + `orchestrator/*.test.ts` + `e2e-issue-lifecycle.test.ts` — 删 insertSpanOrigin 调用中的 traceId/traceparent 字段（或改为 startSpan 自动写）

**验证**：`bun run typecheck && bun run test` 全绿

**风险**：大量测试文件中的 `insertSpanOrigin` 调用带 `traceId: ""`/`traceparent: ""` — 删列后这些字段从 SpanOriginInsert 类型中消失，typecheck 报错。需要批量删这些字段。

---

## 风险矩阵

| # | 风险 | 严重度 | Phase | 缓解 |
|---|------|--------|-------|------|
| R1 | sessionId 拼接泄漏 4 处 | 🔴 高 | 7+8 | 逐个迁移，conversation 用 member.session_id，其余新 ULID |
| R2 | issue.service.test 断言拼接 | 🟡 中 | 8 | 改断言为 conversation member session_id 非空 |
| R3 | reactor.test 断言拼接 | 🟡 中 | 8 | 改断言为 spanId + origin |
| R4 | recordingSupervisor mock | 🟡 中 | 2 | 同步改 mock 签名 |
| R5 | FakeSessionFactory/makeRunDeps 多处引用 | 🟡 中 | 5+6+10 | 逐步替换，最后删 |
| R6 | conversationContextPlugin 测试改 prompt 调用 | 🟡 中 | 4 | 传 opts.conversation |
| R7 | runtime-ops 直接调 notifyRunComplete | 🔴 高 | 2 | 改为 span.end()，supervisor 暴露 getSpan |
| R8 | onRunComplete 回调含 sessionId | 🟢 低 | 7+8 | 回调签名不变，conversation 侧忽略首参 |
| R9 | completeRun 含 sessionId | 🟢 低 | 7 | 删参数 |
| R10 | span-executor 集成测试丢失 | 🟡 中 | 10 | session-manager.test.ts 补集成测试 |
| R11 | install-session 直接 new AgentSession | 🟢 低 | 8 | 改 sessionManager.create |
| R12 | ModelFactory 类型在 session-factory.ts | 🟢 低 | 7 | 移到 title.ts 内联 |
| R13 | convTools 依赖 conversationId 闭包 | 🟡 中 | 7 | buildAgentConfig 保留 convPort/conversationId |
| R14 | 非 conversation 场景 ctx.conversation=undefined | 🟢 低 | 4 | beforeModel 检查 falsy |
| R15 | run-accumulator.test 用 sessionId | 🟡 中 | 7 | 改 fakeOpsStore.getSpanOrigin mock |
| R16 | loop tallyUsage 读 SessionSpec | 🟡 中 | 6 | 改读 AgentSession |

## 验收

```bash
bun run typecheck  # 全绿
bun run test       # 全绿
```
