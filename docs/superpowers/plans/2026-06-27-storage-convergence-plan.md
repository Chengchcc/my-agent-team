# 存储面收敛 — 实施 plan（伪代码 + 数据搬运 + 测试改造）

> 状态：配套 plan（对应 spec `2026-06-27-storage-convergence.md`）
> 基准 HEAD：`33d1e392`。所有 `file:line` 基于 `33d1e392` 工作树核验。
> 上一轮 plan：[`2026-06-27-observability-convergence-plan.md`](./2026-06-27-observability-convergence-plan.md)（同范式）。

---

## 0. 总纲：三条改造线

```text
线 A（生产代码）：删行 / 改 wiring / 加赋值点 / 合 schema —— spec 的 B0/B1/B2 + S1/S2/S3。
线 B（测试夹具）：store.test / insights.test 的 db 构建从 runEventsDbMigrations 切到 openDb(backend)；
                projection.test 加 todo_update 投影夹具。
线 C（测试断言）：删死 kind 断言 / projection_messages 断言；加 B0/B1/B2 回归断言。
```

### 与 spec 编号对应

| spec 项 | 本 plan 章节 | PR |
|---------|-------------|-----|
| B0 readonly PRAGMA | §3.1 | PR-1 |
| B1 todo_update | §3.2 | PR-1 |
| B2 前端 id + 聚合 | §3.3 | PR-1 |
| S2 删 projection_messages | §4 | PR-2 |
| S3 删 runner_health + 收窄 kind | §5 | PR-2 |
| S4 改表名 control_plane_event | §5.3 | PR-2 |
| S1 合库 | §6 | PR-2 |
| B3 migration 核验 | §6.4 + §7 | PR-1/PR-2 |

> PR 切分采纳 spec §7 的**备选合并策略**：S1/S2/S3/S4 都触碰 schema/migration，合成单一 PR-2 一次 `drizzle-kit generate` 出齐，避免重复重生成。B 项（功能 bug）独立 PR-1 先发。

---

## 1. 现状盘点

### 三库 × 表 × 读写方 × 状态

| 库 | 表 | 写方 | 读方 | 状态 |
|----|----|------|------|------|
| backend.db | conversation_ledger / conversation / member / agents / issue / project / column_config / cron_job / deliverable | 各 feature adapter | 各 feature svc + projection | 活，保留 |
| backend.db | **projection_messages** | **无** | **无** | **死**，删（仅 `adapter-sqlite.ts:148` 孤儿 DELETE） |
| events.db | run / attempt / run_origin / surface_health / issue_event | RuntimeOpsStore / SpanSupervisor / cron | RuntimeOpsService / insights | 活，**并入 backend.db** |
| events.db | run_ops_event | supervisor:157 / scheduler:139,152（仅 3 kind） | RuntimeOpsService | 活但枚举超配（15→3） |
| events.db | **runner_health** | **无** | **无** | **死**，删 |
| checkpointer.db | checkpoint_messages / checkpoint_interrupts / checkpoint_events | framework run-loop | framework 恢复 + Ops 只读 store | 活，**保留（包归属边界）** |

### 关键事实（grep 核验，`33d1e392`）

- `lastTodoUpdate =` 赋值方：**0 处**（仅声明 `projection.ts:30` + 初始化 `:50` + 消费 `:218-220`）。
- `run_ops_event` emit kind：`projection_degraded`（`supervisor.ts:157`）/ `retry_requested`（`scheduler.ts:139`）/ `retry_started`（`scheduler.ts:152`），共 3。
- `runner_health` / `runnerHealth`：源码读写 0 处（仅 schema 定义 + service.ts:10 移除注释）。
- `projection_messages`：读写 0 处（仅 `adapter-sqlite.ts:148` DELETE）。
- `store.test.ts:3,11` 用 `runEventsDbMigrations(db)` 建测试 schema。

---

## 2. 测试夹具增量

| 类型 | 夹具 | 用途 |
|------|------|------|
| A 记录型 spy | `appendTodoSpy`（mock ConversationPort.appendTodo） | B1：断言 todo_update 后 onRunComplete 调用了 appendTodo |
| B 数据型 stub | 内存 `checkpoint_events` 行（已存在于 insights.test） | B0：用真实 readonly 连接断言不抛 |
| C 替身工厂 | `makeBackendDb()`：`openDb(":memory:")` 替代 `runEventsDbMigrations(":memory:")` | S1：store.test / insights.test 合库后从单一 backend schema 建表 |

---

## 3. PR-1 — 修 B0/B1/B2

### 3.1 B0 — 删 readonly 连接的 WAL PRAGMA

**生产代码**：`checkpoint-events-store.ts:17` 删除 `db.exec("PRAGMA journal_mode=WAL");`：

```ts
// after — checkpoint-events-store.ts
export function createCheckpointEventsStore(db: Database): CheckpointEventsStore {
  // WAL 由 framework 写方设置并持久化在 checkpointer.db 文件中；
  // 本读方以 { readonly: true } 打开，不得执行写 PRAGMA（否则 SQLITE_READONLY）。
  function parseRows(rows) { ... }   // 其余不变
  return { readBySpan, readBySession, readWindow };
}
```

**测试**：`checkpoint-events-store.test.ts`（若无则新建）——

```ts
it("opens readonly without throwing", () => {
  // 用 framework 写方建一个真实 WAL 库，再以 readonly 打开
  const writer = new Database(tmp);                       // 写方：建表 + 写 WAL
  ensureCheckpointerSchema(writer); writer.close();
  const ro = new Database(tmp, { readonly: true });
  expect(() => createCheckpointEventsStore(ro)).not.toThrow();   // ← B0 回归
  expect(() => ro.query("SELECT 1 FROM checkpoint_events").all()).not.toThrow();
});
```

### 3.2 B1 — todo_update 接通 accumulator

**第一步（核查落点，删前唯一二次确认）**：确认 `todo_update` 当前流经哪条回调——
- 若 framework 把 `todo_update` 写进 `checkpoint_events`：投影侧从事实流读取（无需 accumulator 中转）。
- 若 `todo_update` 仅在 AgentEvent 流（onRunMessage/onRunEvent 回调）：在该回调里赋值 `acc.lastTodoUpdate`。

**生产代码（落点为后者，主路径）**：在 `main.ts` 的 onRunMessage/onRunEvent 回调（投影链路入口）加分支：

```ts
// main.ts onRun* 回调 —— 识别 todo_update 写入 accumulator
if (ev.type === "todo_update") {
  const acc = getOrCreateAccumulator(spanId, senderMemberId);
  acc.lastTodoUpdate = { todos: ev.todos };   // ← 补齐 spec B1 的唯一缺失赋值
  return;                                      // todo_update 不产生消息修订
}
```

`projection.ts:218-220` 的消费端**不动**（它本就正确，只是上游无人喂数据）。

**测试**：`projection.test.ts` 加用例——

```ts
it("appendTodo fires when a todo_update was accumulated", async () => {
  const acc = getOrCreateAccumulator("span-1", "m-1");
  acc.lastTodoUpdate = { todos: [{ id: "t1", text: "x" }] };
  const appendTodo = mock(async () => {});
  await onRunComplete({ ...deps, port: { ...port, appendTodo } }, "span-1", ...);
  expect(appendTodo).toHaveBeenCalledWith("conv-1", "m-1", [{ id: "t1", text: "x" }]);
});
it("appendTodo does not fire when no todo_update", async () => {
  getOrCreateAccumulator("span-2", "m-1");      // lastTodoUpdate 仍 null
  const appendTodo = mock(async () => {});
  await onRunComplete({ ...deps, port: { ...port, appendTodo } }, "span-2", ...);
  expect(appendTodo).not.toHaveBeenCalled();
});
```

> 若第一步核查结论是「todo_update 已入 checkpoint_events」，则改为：投影 helper 从 `checkpointEventsStore.readBySpan` 末次 todo_update 取 todos，accumulator 字段可整体删除（更彻底）。plan 执行时以核查结论为准，spec 验收口径不变（todo 不丢）。

### 3.3 B2 — 前端 id 对齐 + 列表聚合（方案 ①）

**后端新增聚合查询** `service.ts`：

```ts
// service.ts —— session 维度聚合（动线 A 列表 + 详情头）
getSessionDetail(sessionId: string): SessionDetail | null {
  const spans = db.query(
    "SELECT span_id, status, kind, agent_id, started_at, ended_at FROM run WHERE session_id = ? ORDER BY started_at DESC"
  ).all(sessionId) as RunRow[];
  if (spans.length === 0) return null;
  return {
    sessionId,
    agentId: spans[0].agent_id,
    status: deriveSessionStatus(spans),        // running 若任一 span running
    spanCount: spans.length,
    spans: spans.map(toSpanSummary),           // 每行 = 一个 span 摘要
    // 成本累加：对每个 span 读 insights 或在 listRuns 行内已带的聚合字段
  };
}
listSessions(params): SessionRow[] {           // 列表页：groupBy session_id
  return db.query(
    `SELECT session_id, MAX(started_at) AS last_at, COUNT(*) AS span_count,
            MAX(agent_id) AS agent_id
       FROM run GROUP BY session_id ORDER BY last_at DESC LIMIT ?`
  ).all(params.limit) as SessionRow[];
}
```

HTTP 路由 `http.ts` 加 `ops/sessions`（列表）+ `ops/sessions/:sessionId`（聚合详情）；`api.ts` 加 `listOpsSessions` / `getOpsSessionDetail`。

**前端**：
- `sessions/page.tsx:73-84`：`listOpsRuns` → `listOpsSessions`，表格列改为 session 维度（sessionId / agent / span 数 / 最近时间 / 成本），行链接 `/ops/sessions/${sessionId}`。
- `sessions/[sessionId]/page.tsx:24`：`getOpsRunDetail(sessionId)` → `getOpsSessionDetail(sessionId)`；渲染 span 列表（每行链接到 span 详情/瀑布锚点 `#span-${spanId}`）。
- `RunInsightsPanel`（`page.tsx:59`）的 `runId={sessionId}` → 改为接收**选中 spanId**（span 列表点击后才渲染该 span 的 insights），未选中时不渲染或渲染 session 汇总。

**测试**：`service.test.ts` 加 `getSessionDetail` / `listSessions` 用例（多 span 聚合、span 数、状态派生）；前端 e2e 四级导航（列表→session→span→瀑布）数据非空。

---

## 4. PR-2 §A — 删 projection_messages（S2）

**生产代码**：
- 删 `schema.ts:86-91`（表定义 + 注释）。
- 删 `adapter-sqlite.ts:145-148`（孤儿 DELETE + 注释 "Delete projection_messages by thread ID"）。

**migration**：`DROP TABLE projection_messages;`（纯 DROP，§6.4 核验安全）。

**测试**：`adapter-sqlite.test.ts` 若有删 conversation 用例，去掉 projection_messages 相关断言；全仓 `grep -r "projection_messages\|projectionMessages"` 归零。

---

## 5. PR-2 §B — 删 runner_health + 收窄 kind（S3）+ 改表名（S4）

**生产代码（S3）**：
- 删 `events-schema.ts:94-105`（`runnerHealth` 表）。
- `types.ts:20-35`：`RunOpsEventKind` 15 → 3（保留 `projection_degraded` / `retry_requested` / `retry_started`）。

**migration（S3）**：`DROP TABLE runner_health;`。kind 收窄**无 migration**（列是裸 TEXT 无 CHECK，仅 TS 类型变更）。

**测试（S3）**：`store.test.ts` / `service.test.ts` 删引用死 kind 的断言；TS 编译通过（任何残留死 kind 引用会编译失败，作为回归网）。

### 5.1 abort/cancel 无事件 — 实证结论（回应「abort 没有事件了吗」）

grep `appendRunEvent` 全部 emit 方仅 3 处，**无一是 abort/cancel**：`scheduler.ts:137`（retry_requested）/ `scheduler.ts:150`（retry_started）/ `supervisor.ts:154`（projection_degraded）。

`abort_sent` 在源码仅作 **HTTP 返回状态串**，从不写库：
- `service.ts:301-305` `cancel()` → `return { state: "abort_sent" }`（只调 `supervisor.cancel()` 终止进程内 session）。
- `run-query-service.ts:137` 同款返回串。

→ 删 `abort_sent` 枚举值**零观测损失**，因为它从来没被 emit 过（runner/reattach 时代词汇，AgentSession 进程内执行后无 reattach）。

**可选增强（默认不做，待决策）**：若要让 cancel 动作可观测，在 `cancel()` 成功分支补 `appendRunEvent({ kind: "cancel_requested", spanId, attemptSeq })`，枚举改回 3 → 4 保留 `cancel_requested`。这是新增功能，与删死枚举正交。

### 5.2 S4 — `run_ops_event` → `control_plane_event` 物理改名

**生产代码（5 处，grep 实证）**：
- `events-schema.ts:50-65`：drizzle symbol `runOpsEvent` → `controlPlaneEvent`；`sqliteTable("run_ops_event", …)` → `"control_plane_event"`；3 个 `index("idx_run_ops_event_*")` → `idx_control_plane_event_*`。
- `store.ts`（symbol `runOpsEvent` 用于 :14/73/82/90-92/100-102）：随 schema 改引用名。
- `service.ts`：注释/类型引用随改。
- `TraceWaterfall.tsx:33`：文档串改名。

**migration（折叠进 §6 合库那一次）**：

```sql
-- 保留环境：手写 RENAME，绝不 drop+recreate
ALTER TABLE run_ops_event RENAME TO control_plane_event;
DROP INDEX IF EXISTS idx_run_ops_event_span;
DROP INDEX IF EXISTS idx_run_ops_event_trace;
DROP INDEX IF EXISTS idx_run_ops_event_kind;
CREATE INDEX idx_control_plane_event_span  ON control_plane_event (span_id, seq);
CREATE INDEX idx_control_plane_event_trace ON control_plane_event (trace_id, seq);
CREATE INDEX idx_control_plane_event_kind  ON control_plane_event (kind, ts DESC);
```

> 空环境（`gen-drizzle.sh` 重建）：直接以新名 `control_plane_event` 建表，连 RENAME 都省。

**文档**：只改活文档 `docs/architecture/`（data-model / overview / identifiers / system-overview）+ 本 spec/plan。`docs/superpowers/{specs,retros,plans}/` 下 m16/m18.7/m20 等**归档历史文档不改**（保留其记录的当时事实）。

**测试**：`store.test.ts` 表名/symbol 断言改新名；TS 编译（残留旧 symbol 引用编译失败作回归网）。

---

## 6. PR-2 §C — events.db 并入 backend.db（S1）

### 6.1 schema 合并

- `events-schema.ts` 6 表（删 runner_health 后）的定义迁入 `schema.ts`（或 `schema.ts` 末尾 `export * from "./events-schema.js"` 后续再物理合并）。建议**物理合并到 `schema.ts`**，删 `events-schema.ts`，单一 schema 源。
- `drizzle.backend.config.ts` 的 `schema` 指向不变（仍 `schema.ts`），它现在覆盖全部表。
- 删 `drizzle.events.config.ts`；`gen-drizzle.sh:10` 删 events generate 那条。

### 6.2 运行时 wiring（main.ts）

```ts
// after — main.ts bootstrap（单一 backend 连接）
const db = openDb(`${config.dataDir}/backend.db`);   // WAL + drizzle/backend migration（含原 events 6 表）
const opsStore = new RuntimeOpsStore(db);            // ← 从 eventsDb 改为 db
const supervisor = new SpanSupervisor({ config, opsStore, tracer, db, onReap });  // db: eventsDb → db
// 删：eventsDb 声明（:68-70）、runEventsDbMigrations(:71)、import(:52)
// checkpointDb（:216 readonly）保持不变
```

- 删 `features/span/events-db-migrations.ts`。
- 关闭序（`main.ts:368` 附近）：原「先停 cron 再让 supervisor 关 eventsDb」简化为单 `db.close()`；确认 supervisor 不再持有独立 eventsDb 句柄。
- `busy_timeout`：可在 `openDb`（`infra/sqlite/db.ts:15-16`）补 `sqlite.exec("PRAGMA busy_timeout=5000")`（合库后单连接，竞争更小，可选项）。

### 6.3 数据搬运脚本（保留环境用）

开发环境（gitignore 的 `.backend-data`）直接 `gen-drizzle.sh` 重建，无需搬运。若有需保留数据的环境，出一次性脚本：

```sql
-- migrate-events-to-backend.sql（一次性，在 backend.db 连接上执行）
ATTACH DATABASE 'events.db' AS ev;
INSERT INTO run                 SELECT * FROM ev.run;
INSERT INTO attempt             SELECT * FROM ev.attempt;
INSERT INTO control_plane_event SELECT * FROM ev.run_ops_event;  -- 源旧名 → 目标新名（S4）
INSERT INTO run_origin          SELECT * FROM ev.run_origin;
INSERT INTO surface_health      SELECT * FROM ev.surface_health;
INSERT INTO issue_event         SELECT * FROM ev.issue_event;
-- 注意：不搬 runner_health（已删）
DETACH DATABASE ev;
```

执行前提：backend.db 已跑完含 events 6 表的 migration（建好空表）。脚本只追加数据，绝不 drop。

### 6.4 B3 — migration SQL 人工核验

`drizzle-kit generate` 后逐条审查输出 SQL：

- ✅ 允许：`CREATE TABLE run/attempt/...`（events 6 表新建于 backend）、`DROP TABLE projection_messages`、`DROP TABLE runner_health`、`ALTER TABLE run_ops_event RENAME TO control_plane_event` + 重建 3 index（S4）。
- ❌ 禁止：任何 `DROP TABLE` + `CREATE TABLE` 重建 `conversation_ledger` / `conversation` / `issue` / `cron_job` / `deliverable` / `run_ops_event` 等有数据表。若 drizzle 误产 drop+recreate（尤其 S4 改名 drizzle 易误判为删旧建新），手写 ALTER RENAME 替代。

### 6.5 测试夹具切换

```ts
// store.test.ts / insights.test.ts —— before
import { runEventsDbMigrations } from "../span/events-db-migrations.js";  // 删
const db = new Database(":memory:"); runEventsDbMigrations(db);            // 删

// after —— 用 backend 统一 schema 建表
import { openDb } from "../../infra/sqlite/db.js";
const db = openDb(":memory:");           // 含原 events 6 表
const store = new RuntimeOpsStore(db);
```

---

## 7. 施工顺序与依赖

```text
PR-1  B0 + B1 + B2               ← 功能 bug，独立先发，无 migration 风险
PR-2  S2 + S3 + S4 + S1（合并）   ← 一次 drizzle-kit generate 出齐 DROP projection_messages / DROP runner_health / RENAME run_ops_event→control_plane_event / 合表
       └─ B3 核验贯穿，数据搬运脚本随附
```

**强依赖**：PR-2 内 S2/S3 的 schema 删除、S4 的改名、S1 的合库在同一次 migration 生成，必须一起。PR-1 与 PR-2 解耦。

---

## 8. 测试改造横切原则

1. **db 构建统一走 `openDb`**：所有原先 `runEventsDbMigrations(:memory:)` 的测试切到 `openDb(":memory:")`（合库后单一 schema 源）。
2. **死 kind / projection_messages 断言清零**：编译期由 TS 类型收窄兜底（残留引用编译失败）。
3. **B 项加正向 + 负向回归**：B0（readonly 不抛）、B1（有/无 todo_update 两路）、B2（聚合非空 + id 对齐）。
4. **migration 双路冒烟**：空库启动 + 含数据库（跑搬运脚本后）启动，断言两库连接数 = 2（backend + checkpointer）。

---

## 9. 验收总清单

- [ ] PR-1：B0 readonly 不抛 / B1 todo 不丢（两路用例）/ B2 列表聚合 + 详情 id 对齐（e2e 四级导航非空）。
- [ ] PR-2：`events.db` 6 表入 `backend.db`；运行时仅 2 个 DB 连接；`events-db-migrations.ts` + `drizzle.events.config.ts` + `events-schema.ts` 删除。
- [ ] PR-2：`projection_messages` / `runner_health` 表 + 引用全删；`run_ops_event.kind` 3 值。
- [ ] PR-2：`run_ops_event` 表改名 `control_plane_event`（含 RENAME + 3 index 重建）；活文档 `docs/architecture/` 4 篇同步；归档历史文档不改。
- [ ] migration SQL 人工核验无 drop+recreate 有数据表；空库 + 有数据库两路冒烟通过。
- [ ] 全仓 grep `projection_messages|runner_health|runner_?[Hh]ealth|events\.db|runEventsDbMigrations` 仅余文档/搬运脚本；`run_ops_event|runOpsEvent` 仅余归档历史里程碑文档。

---

## 10. 关联

- 配套 spec [`2026-06-27-storage-convergence.md`](../specs/2026-06-27-storage-convergence.md)
- 上一轮 plan [`2026-06-27-observability-convergence-plan.md`](./2026-06-27-observability-convergence-plan.md) —— 同范式（基准 HEAD `33d1e392` 即其 spec 的实现）
- 架构页 [`foundations/facts-and-projections.md`](../../architecture/foundations/facts-and-projections.md) / [`foundations/identifiers.md`](../../architecture/foundations/identifiers.md) / [`backend/event-log.md`](../../architecture/backend/event-log.md)
