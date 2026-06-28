# ORM 归位 + DI 瘦身

> 状态：审计 spec
> 基准 HEAD：`678d5269`（RunOpsEvent* → ControlPlaneEvent* 改名完成）
> 上游：存储面收敛 spec `2026-06-27-storage-convergence.md`（S1 合库完成后暴露的 DI 冗余和原始 SQL 问题）

---

## 0. 出发点

S1 把 `events.db` 并入了 `backend.db`。`run`/`attempt`/`control_plane_event`/`run_origin`/`surface_health`/`issue_event` 六张表已经通过 drizzle schema 定义为 ORM 实体。但大量代码仍在用 `db.query("SELECT ...")` / `db.run("INSERT ...")` 绕过 ORM。

同时，`db`（bun:sqlite 原始连接）和 `opsStore`（`new RuntimeOpsStore(db)`——drizzle 包装）在很多函数的参数里同时出现。合库后它们是同一个物理连接，双参数 = 冗余依赖。

## 1. 审计结论

### 1.1 原始 SQL 盘点（生产代码，不含 test）

| 文件 | 原始 SQL 行数 | 表 | 结论 |
|------|-------------|-----|------|
| `service.ts` | 2 (`listRuns`、`getRunDetail`) | `run`, `attempt` | **该修** — schema 已有，绕过 ORM |
| `supervisor.ts` | 6 (全部 INSERT/UPDATE/SELECT) | `run`, `attempt` | **该修** — 生命周期写操作，可以用 drizzle transaction |
| `conv-svc-factory.ts` | 1 (`verifyRunOwnsConversation`) | `run` | **该修** — 查 sessionId，已有 schema |
| `agent-svc-factory.ts` | 2 (`purgeEventsForSessions`) | `run`, `attempt` | **该修** — DELETE 含子查询，drizzle 可表达 |
| `agent-svc-factory.ts` | 2 (`listSessionIds`、`assertNoActiveRun`) | `member` | **保留** — `member` 表无独立 drizzle store |
| `buildRunQuery` | 动态 SQL 构建 | `run`, `attempt` | **保留** — 动态多条件拼 SQL，ORM 更啰嗦，负收益 |
| `*adapter-sqlite.ts` | 多处 | 各表 | **保留** — adapter 模式的职责就是封装原始 SQL |

### 1.2 DI 冗余盘点

| 函数 | 冗余 | 严重度 |
|------|------|--------|
| `createRuntimeOpsService({ db, opsStore })` | `opsStore = new RuntimeOpsStore(db)`，传两个 | 高 |
| `SpanSupervisorOptions = { db, opsStore }` | 同上，但语义不同（写/读分责） | 中（可接受） |
| `createConversationFeature(db, ..., _opsStore)` | `_opsStore` 纯透传给内部 `makeRunDeps` | 中 |
| `createRunQueryService({ db, opsStore })` | **死代码**——全仓零调用方 | 直接删 |

### 1.3 无需改动

| 函数 | 理由 |
|------|------|
| `RunDeps.opsStore` | 只收 `opsStore`，已对 |
| `createCronScheduler.opsStore` | 同上 |
| `OrchestratorDeps.opsStore` | 同上 |
| `createAgentSvc.db` | 只收 `db`，内部自建 adapter |
| `RunInsightsDeps.checkpointEventsStore` | 独立 checkpointer.db，不相关 |

---

## 2. 修法

### 2.1 给 `RuntimeOpsStore` 补方法

```ts
// store.ts 新增
getRunBySpanId(spanId: string): { status; sessionId; ... } | null
getSessionIdBySpanId(spanId: string): string | null
deleteRunsBySession(sessionId: string): void
```

### 2.2 `supervisor.ts`：6 处原始 SQL → drizzle

- `#reapStaleRuns`：JOIN 查询 → `.select().from().innerJoin().where()`
- `#finalizeRun`：CAS UPDATE → `.update().set().where(and(eq, isNull))` + drizzle transaction
- `#markProjectionDegraded`：UPDATE → `.update().set().where()`
- `startMainRun`：INSERT + SELECT MAX → `.insert()` + `.select()` + drizzle transaction

### 2.3 `service.ts`：删 `db` 参数

将 `listRuns`/`getRunDetail` 调用 `db.query()` 的地方改为走 `opsStore` 新方法。删掉 `db: Database` 参数。

### 2.4 `conv-svc-factory.ts`：删 `_opsStore` 参数 + 原始 SQL

`verifyRunOwnsConversation` 用 `opsStore.getSessionIdBySpanId()` 替代。`_opsStore` 改为在内部从闭包获取或从 `db` 构造。

### 2.5 `agent-svc-factory.ts`：`purgeEventsForSessions` → drizzle

用 `supervisor.getDrizzle()`（需新增）做 DELETE + 子查询。

### 2.6 删 `createRunQueryService`（死代码）

---

## 3. 施工顺序

```text
Phase 1: RuntimeOpsStore 补方法 (getRunBySpanId, getSessionIdBySpanId, deleteRunsBySession)
Phase 2: supervisor.ts → drizzle (新增 getDrizzle(), 6 处转 ORM)
Phase 3: service.ts → 删 db, 调用 opsStore 新方法
Phase 4: conv-svc-factory.ts → 删 _opsStore + 原始 SQL
Phase 5: agent-svc-factory.ts → purgeEvents 转 drizzle
Phase 6: 删 createRunQueryService 死代码
```

每个 phase 跑 typecheck + test。

---

## 4. 验收

- [ ] `supervisor.ts`：零 `this.#db.query/run/exec`，全部走 drizzle
- [ ] `service.ts`：`createRuntimeOpsService` 无 `db` 参数
- [ ] `conv-svc-factory.ts`：无 `_opsStore` 参数，无原始 SQL
- [ ] `agent-svc-factory.ts`：`purgeEventsForSessions` 走 drizzle
- [ ] `createRunQueryService` 已删除
- [ ] 全仓 typecheck clean，test 全过
