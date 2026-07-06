# Plan: 塌缩 harness 调用层 (v4 — TDD 顺序)

## LSP 精确分析

| 删除/修改的符号 | 源码引用（文件数×引用数） | 测试引用 |
|---|---|---|
| SessionFactory | 7 × 18 | session-factory.test.ts, loop-step.test.ts, http.test.ts |
| SessionSpec | 3 × 5（+8 自身） | loop-step.test.ts |
| buildSessionSpec | 4 × 7 | 无 |
| createSessionFactory | 3 × 5 | session-factory.test.ts |
| executeAgentRun | 4 × 7 | span-executor.test.ts |
| makeRunDeps | 4 × 7 | span-executor.test.ts |
| RunDeps/RunRequest/SpanOrigin | 仅自身 | 无 |
| parseSessionId | 3 × 8 | 无 |
| deriveSessionId | 1 × 2 | 无 |
| FakeSessionFactory | mock-deps + http.test.ts | — |

---

## 执行顺序 (TDD)

### Step 1: tracePlugin —— 纯新增，标准 TDD

```
1. 写 test → 跑红
2. 写 plugin impl → 跑绿
3. bun test packages/plugin-trace/
```

**验证信号**: 新增代码自测通过，不影响任何现有代码。

---

### Step 2: http.test.ts —— 有测试，先改 test

```
1. 改 http.test.ts: fakeSessionFactory → fakeSessionMap
   改 makeApp: { sessionFactory } → { sessionMap: Map<string, mock> }
   → bun test http.test.ts → 跑红（源码还是 SessionFactory）

2. 改 http.ts: resumeRoutes(deps: { sessionFactory }) → deps: { sessionMap: Map<string, AgentSession> }
   factory.peek(sid) → sessionMap.get(sid)
   → bun test http.test.ts → 跑绿
```

**验证信号**: resume 测试全绿。其他引用 SessionFactory 的代码不受影响（session-factory.ts 还在）。

---

### Step 3: loop-step.test.ts —— 有测试，先改 test

```
1. 改 loop-step.test.ts:
   - mockSessionFactory → buildConfig 回调返回 AgentSessionConfig
   - SessionSpec 类型引用 → AgentSessionConfig
   → bun test loop-step.test.ts → 跑红（源码还是旧接口）

2. 改 loop-step.ts + loop/http.ts:
   - SessionFactory → 删入参
   - SessionSpec → AgentSessionConfig
   - buildSpec 回调签名更新
   - factory.getOrCreate + enqueuePrompt → new AgentSession(config).prompt()
   → bun test loop-step.test.ts → 跑绿
   → bun test apps/backend/src/features/loop/ → 全绿
```

**验证信号**: loop step 测试全绿。

---

### Step 4: 无测试的 feature —— typecheck 守卫，逐个迁移

```
4a. conversation-compose.ts:
    - 删 makeRunDeps + executeAgentRun 调用
    - 改为 new AgentSession(config) + subscribe + prompt
    - 删 parseSessionId 调用 → conversationId/memberId 从 ctx 拿
    → bun run typecheck apps/backend/  ← 每改一个，即时验

4b. cron/scheduler.ts:
    - fire(): 删 executeAgentRun → new AgentSession + prompt
    - fireLoop(): 删 buildSessionSpec/sessionFactory → buildAgentConfig
    → bun run typecheck apps/backend/

4c. orchestrator/reactor.ts:
    - startStep: 删 executeAgentRun → new AgentSession + prompt
    → bun run typecheck apps/backend/

4d. install-session.ts:
    - new AgentSession(config).prompt()（已经接近，删 factory import 即可）
    → bun run typecheck apps/backend/

4e. main.ts:
    - 删 createSessionFactory, buildSessionSpec import
    - 加 sessionMap: Map<string, AgentSession>
    - supervisor reaper: onReap(sid) → sessionMap.get(sid)?.dispose()
    - resumeRoutes: { sessionMap, getSessionIdByRunId }
    - loop/install wiring 简化
    → bun run typecheck apps/backend/
```

**验证信号**: 每个 feature 改完后 typecheck 即时绿。

---

### Step 5: 清场 —— typecheck 自动发现残留

```
1. 删 span-executor.ts
   → typecheck 报: span-executor.test.ts 找不到 import → 删 test
   → typecheck 报: mock-deps.ts 的 makeRunDeps 引用不存在 → 删 mock-deps 里的 makeRunDeps

2. 删 session-factory.ts
   → typecheck 报: session-factory.test.ts 找不到 import → 删 test
   → typecheck 报: mock-deps.ts 的 FakeSessionFactory 等引用不存在 → 删

3. 删 conversation/service.ts 里的 parseSessionId / deriveSessionId
   → typecheck 报: index.ts re-export 找不到 → 更新 barrel
   → typecheck 报: conversation-compose / run-accumulator 引用不存在 → 已改过，确认 OK

4. 删 schema.ts 里的 traceId / traceparent 列 → drizzle generate

5. bun run test → 全绿
```

**验证信号**: typecheck 做导游——哪个删了报错就清理哪个，不会多删不会漏删。最后全仓 test 绿。

---

## 不做的

- `OWNER_MEMBER_ID` 保留——是 conversation member 概念，不是 session 概念
- `ModelFactory` 移到 `title.ts` 内联定义（只有一个外部使用者）
- `conversation_session` 表本次不做——session 持久化映射延后，当前 `parseSessionId` 的替代用 DB 查 `span` 表即可（`opsStore.getSpanOrigin` 已返回 `conversationId`）

## 验收

```bash
bun run typecheck  # 全绿
bun run test       # 全绿
```
