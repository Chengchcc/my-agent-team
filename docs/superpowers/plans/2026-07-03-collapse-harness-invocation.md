# Plan: 塌缩 harness 调用层 (Handoff-ready)

## 风险总览

### 🔴 高 —— 测试全面破坏
| 风险 | 文件 | 详情 |
|------|------|------|
| FakeSessionFactory 删除 | `test-helpers/mock-deps.ts:338-391` | 仅 `http.test.ts` 用，需改为 `Map<string, AgentSession>` |
| loop mockSessionFactory | `loop-step.test.ts:145` | 本地 mock，实现完整 SessionFactory iface，需适配 |
| span-executor.test.ts 删除 | 整个文件 | `executeAgentRun` 测试跟着死 |
| session-factory.test.ts 删除 | 整个文件 | 13 个测试跟着死 |

### 🟡 中 —— 调用链断裂
| 风险 | 文件 | 详情 |
|------|------|------|
| reaper dispose | `main.ts:95` | `onReap: sessionFactory.dispose(sid)` → 需 `sessionMap.get(sid)?.dispose()` |
| resume peek | `http.ts:23` | `factory.peek(sid)` → `sessionMap.get(sid)` |
| cron fire() 用 executeAgentRun | `scheduler.ts:67-80` | 改为直接 `new AgentSession` + `prompt()` |
| orchestrator startStep 用 executeAgentRun | `reactor.ts:107-114` | 同上 |
| conversation startAgentRun 用 executeAgentRun | `conversation-compose.ts:131-165` | 同上，最复杂（有 subscribe 回调和 parseSessionId） |
| cron fireLoop 用 sessionFactory | `scheduler.ts:106,118` | 改为直接创建 session |

### 🟢 低 —— 概念清理
| 风险 | 文件 | 详情 |
|------|------|------|
| parseSessionId 删除 | `run-accumulator.ts:135`, `conversation-compose.ts:85,87,160`, `service.ts:36` | `conversationId` 和 `memberId` 改为 DB 查或参数传 |
| deriveSessionId 删除 | `service.ts:23` | 仅 `forkAgentRuns:166` 调用 |
| OWNER_MEMBER_ID | `cron/service.ts:106`, `issue/service.ts:75,99` | 保留——是 conversation member 概念，非 session |
| buildSessionSpec in cron scheduler | `scheduler.ts:148-161` | 改为直接构建 AgentSessionConfig |
| conversation_session 表 | `schema.ts` | 新增: `(conversationId, agentMemberId) → sessionId` |
| traceId 列删除 | `schema.ts`, drizzle snapshots | Migration 生成 |

---

## Phase 1: tracePlugin (新增)

**Target**: `packages/plugin-trace/src/index.ts`

```ts
// hooks:
//   onSessionCreate → spanId = ulid(), INSERT span + attempt, emit spanId
//   onAgentEnd → finalize span via supervisor

export function defineTracePlugin(opts: {
  opsStore: RuntimeOpsStore;
  supervisor: SpanSupervisor;
}): Plugin {
  let spanId: string | null = null;
  let attemptSeq: number | null = null;

  return {
    name: "trace",
    hooks: {
      async beforeRun(ctx, messages) {
        spanId = crypto.randomUUID();
        attemptSeq = await supervisor.startMainRun(spanId, ctx.sessionId, {...});
      },
      async onEvent(event) {
        if (event.type === "agent_end") {
          await supervisor.notifyRunComplete(
            ctx.sessionId, spanId!, event.status, "main", attemptSeq
          );
        }
      },
    },
  };
}
```

**Note**: tracePlugin 目前不能是 "true plugin"（hooks 接口不支持 onEvent）。先用 **wrapper 函数**——在外面 subscribe session 事件来处理 supervisor 回调。plugin 标记为后续迁移。

## Phase 2: 删除旧代码

### 2a. 删除文件
```
rm apps/backend/src/features/span/span-executor.ts
rm apps/backend/src/features/span/span-executor.test.ts
rm apps/backend/src/features/span/session-factory.ts
rm apps/backend/src/features/span/session-factory.test.ts
```

### 2b. 删除 mock-deps 相关
```
mock-deps.ts: drop FakeSessionFactory (lines 338-391)
mock-deps.ts: drop makeRunDeps (line 468, unused)
mock-deps.ts: drop fakeGetSessionIdByRunId — 改为 sessionMap 查询
```

## Phase 3: ID 模型修正

### 3a. schema.ts
```
+ conversation_session 表:
    conversationId text PK
    agentMemberId text PK
    sessionId text not null

- span_origin.traceId 列
- span_origin.traceparent 列
```

### 3b. service.ts
```
- deriveSessionId()
- parseSessionId()
保留 OWNER_MEMBER_ID (是 member 概念，非 session)
```

### 3c. 迁移
```bash
bunx drizzle-kit generate
```

## Phase 4: 各 Feature 迁移

### 4a. Conversation (最复杂)

**conversation-compose.ts `startAgentRun`**:
```ts
startAgentRun: async (spanId, sessionId, ctx) => {
  // 1. 构建 config
  const agent = await agentSvc.getById(ctx.agentId);
  const config: AgentSessionConfig = {
    sessionId,
    model: makeModel(agent),
    tools: [bashTool, readTool, writeTool, ...convTools],
    plugins: [tracePlugin, identityPlugin, conversationContextPlugin, ...],
    checkpointer: sqliteCheckpointer({ db: ... }),
    contextManager: pipeContextManagers(truncator, autoSummarize),
  };

  // 2. 创建 session (不 dispose — conversation session 复用)
  const session = new AgentSession(config);

  // 3. subscribe 事件
  session.subscribe((event) => {
    if (event.type === "message" || event.type === "message_update") {
      void handleAssistantMessage(ctx.conversationId, ctx.agentMemberId, event.payload);
    }
    if (event.type === "todo_update") {
      acc.lastTodoUpdate = event.payload;
    }
  });

  // 4. 跑
  await session.prompt(ctx.input ?? "");
}
```

**关键改动**:
- `handleAssistantMessage` 不再需要 `parseSessionId`——conversationId/memberId 直接来自 ctx
- `onRunComplete` → 改为 supervisor.onRunComplete 监听，sessionId 由 supervisor 事件提供
- `run-accumulator.ts:135` 的 `parseSessionId(sessionId)` → sessionId 不再编码语义，需要修改 supervisor.onRunComplete 回调签名加上 `conversationId`

### 4b. Cron

**scheduler.ts `fire()`**:
```ts
const config: AgentSessionConfig = {
  sessionId, model, tools, plugins: [tracePlugin], ...
};
const session = new AgentSession(config);
session.subscribe(ev => { if (ev.type === "agent_end") handleComplete(spanId); });
await session.prompt(input);
session.dispose();
```

`fireLoop` 也一样——删 sessionFactory 入参，去掉 `buildSpec` 回调解包。

### 4c. Orchestrator

`reactor.ts startStep`：同 cron 路径。

### 4d. Loop

**loop-step.ts**:
- 删 `sessionFactory` 入参，删 `SessionSpec` 类型
- `buildSpec` 回调改为返回 `AgentSessionConfig`
- 内部: `new AgentSession(config).prompt(...)` 替代 `factory.getOrCreate + enqueuePrompt`

**loop/http.ts**:
- 删 `sessionFactory` 入参
- `buildSpec` 回调类型更新

**cron/scheduler.ts fireLoop**:
- 删 `buildSpec` 内部 helper
- 直接传 `AgentSessionConfig` 构建函数给 loopStep

### 4e. install-session.ts

改为 `new AgentSession(config).prompt()` —— 已经接近了，只需删 sessionFactory 相关 import。

## Phase 5: main.ts 清理

```ts
// 删除
- const sessionFactory = createSessionFactory({ config });
- import { buildSessionSpec, createSessionFactory } from ...

// 新增
+ const sessionMap = new Map<string, AgentSession>();

// 改动
- supervisor reaper: onReap: sessionFactory.dispose(sid)
+ supervisor reaper: onReap: sessionMap.get(sid)?.dispose()

- resumeRoutes({ sessionFactory, ... })
+ resumeRoutes({ sessionMap, ... })

- loopRoutes(..., sessionFactory, buildSessionSpec(...), ...)
+ loopRoutes(..., (params) => buildAgentConfig(params), ...)

- cron scheduler deps: sessionFactory
+ cron scheduler deps: (nothing — it creates sessions directly)

- orchestrator deps: sessionFactory
+ orchestrator deps: (nothing)

- conversation compose: _sessionFactory
+ conversation compose: (nothing — it creates sessions directly)
```

## Phase 6: 测试修复

| 文件 | 变更 |
|------|------|
| `http.test.ts` | `fakeSessionFactory` → `Map<string, mock>` |
| `loop-step.test.ts` | `mockSessionFactory` → `new AgentSession` mock |
| `conversation-compose.test.ts` (if any) | adapt to new path |
| `supervisor.test.ts` | reaper 改为 `Map.get(id)?.dispose()` |
| `mock-deps.ts` | 删 FakeSessionFactory, 加 `fakeSessionMap()` |

## Phase 7: 验证

```bash
bun run typecheck   # 全仓
bun run test        # 全仓 test
```

## 执行顺序 (严格有向)

```
Phase 1 (tracePlugin) → Phase 2 (delete) → Phase 3 (schema) → Phase 4 (migrate) → Phase 5 (main) → Phase 6 (tests) → Phase 7 (verify)
```

Phase 2-3 可并行。Phase 4 依赖 2+3。Phase 5 依赖 4。Phase 6 依赖 5。
