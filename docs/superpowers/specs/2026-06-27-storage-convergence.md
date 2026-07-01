# 存储面收敛：按归属合库 + 砍 runner 时代死表 + 修 33d1e392 遗留 bug

> 状态：实施 spec（含逐项 before/after、文件行号、产品动线、回归点、分阶段 PR）
> 基准 HEAD：`33d1e392`（`feat(backend): observability convergence + run-to-span rename`——观测面收敛的**实现**提交，本 spec 在其之上做存储面收敛 + 收尾 bug）
> 所有 `file:line` 均基于 `33d1e392` 工作树核验，非 dist/.turbo 残留。
> 上游依据：架构页 [`foundations/facts-and-projections.md`](../../architecture/foundations/facts-and-projections.md)（事实流归属 checkpointer / 投影归属 ledger）+ [`backend/event-log.md`](../../architecture/backend/event-log.md)（EventLog tombstone）+ [`foundations/identifiers.md`](../../architecture/foundations/identifiers.md)（session=trace / span=prompt loop）。文档已先行收敛，本 spec 把存储层追上文档。

---

## 0. 出发点：观测面接通了，但存储层还在按「功能」分库

上一轮（`observability-convergence`，即 `33d1e392`）把**观测面**接到了活事实流（checkpointer 的 `checkpoint_events`），并完成 `run`→`span` 改名。HEAD 核验，这些已经是事实：

- `run` 表按 `span_id` 主键（`events-schema.ts:17`），一行 = 一个 span（一次 prompt loop）。
- `checkpoint_events` 已带 `spanId` 列（`schema.ts:20`），可按 `(sessionId, spanId)` 切片。
- Ops 经只读 store 直连 `checkpointer.db` 读事实流（`checkpoint-events-store.ts`、`main.ts:216-217`）。
- `event_log` 表已删（`events-schema.ts:107` tombstone 注释）。
- 路由已 `/ops/runs`→`/ops/sessions`（`app/(main)/ops/sessions/`）。

**但存储层还有三类没收敛的债，外加 `33d1e392` 自身引入/遗留的 4 个功能 bug：**

1. **三个库按「功能类别」分，而不是按「归属」分**：`backend.db`（领域真相）、`events.db`（运维/控制面）、`checkpointer.db`（框架工作态 + 执行事实流）。其中 `events.db` 的 7 张表全部由 backend 包独占读写（`RuntimeOpsStore`、`SpanSupervisor`、cron），**没有任何包边界理由独立成库**——它纯粹是历史上「ops 信号另开一个文件」的惯性。`checkpointer.db` 才有真边界（framework 包独占）。结论：`events.db` 应并回 `backend.db`，三库收敛成两库。

   > 「单写者锁/性能」**不是**拆库理由：`bun:sqlite` 同步调用 + JS 事件循环天然串行化写入，WAL 允许并发读写，且写入量极低。唯一站得住的拆分依据是**包归属**——`checkpointer.db` 属 framework 包，`events.db` 不属任何独立包。

2. **「messages」存了三份**：`conversation_ledger`（append-only 产品真相，`schema.ts:66`）+ `checkpoint_messages`（framework 线程工作态，`checkpointers/schema.ts:3`）+ `projection_messages`（渲染快照缓存，`schema.ts:87`）。其中 `projection_messages` 与 `checkpoint_messages` schema **逐字段相同**（`sessionId` PK / `messages` / `updatedAt`），且**全仓零写入方、零读取方**——唯一引用是 `adapter-sqlite.ts:148` 的一句孤儿 `DELETE`。`projection.ts:22-24` 注释自承「ledger 是 canonical source，eager 物化 thread_projection 是 M9 恢复路径的残骸」。它是第三份冗余，可直接删。

3. **runner 时代的死表 / 死枚举还在**：
   - `runner_health` 表（`events-schema.ts:95-105`）：runner daemon 删除后无任何读写方（`service.ts:10` 自承 "runner_health removed (AgentSession runs in-process, no runner daemon)"，`RuntimeOpsStore` 零方法），纯死表。
   - `run_ops_event.kind` 枚举 15 个值（`types.ts:20-35`），实际只有 3 个被 emit：`projection_degraded`（`supervisor.ts:157`）、`retry_requested`（`scheduler.ts:139`）、`retry_started`（`scheduler.ts:152`）。其余 12 个是 runner/reattach 时代词汇，全死。

4. **`33d1e392` 自身的 4 个功能 bug（必须随本里程碑一并修，否则观测面/产品闭环带病）：**
   - **P0 — readonly 连接执行 WAL PRAGMA 必崩**：`checkpoint-events-store.ts:17` 在以 `{ readonly: true }` 打开的连接（`main.ts:216`）上执行 `db.exec("PRAGMA journal_mode=WAL")`。WAL 是写操作，readonly 连接执行会抛 `SQLITE_READONLY`——**Ops 详情页/Insights 一加载就 500**。
   - **P1 — todo_update 投影永久丢失**：`projection.ts:218-220` 的 `appendTodo` 依赖 `acc.lastTodoUpdate`，但该字段**全仓只声明 + 初始化为 null，从无任何赋值方**（grep 确认）。run 期间 agent emit 的 todo 更新静默丢弃。
   - **P2 — 前端 session 详情页 id 张冠李戴**：`sessions/[sessionId]/page.tsx:24` 把 URL 的 `sessionId` 直接喂给 `api.getOpsRunDetail()`，而后端 `getRunDetail` 查的是 `WHERE span_id = ?`（`service.ts:209-214`）。`sessionId ≠ spanId`，详情页**必空**（404 / 无数据）。同源问题：`sessions/page.tsx` 列表只平铺 run，**没有按 session 聚合**——动线 A「session 收纳多个 span」根本没实现。
   - **P3 — 合库 migration 数据安全**：drizzle 列改名/合表若无显式 ALTER migration，`drizzle-kit generate` 可能产出 drop+recreate，丢历史数据。合库时必须人工核验生成的 SQL。

一句话：**观测面已接活事实流，但存储层仍按功能分三库、messages 存三份、runner 死表未清，且 `33d1e392` 留了 4 个带病点。本 spec 把存储层按归属收敛到两库，删第三份 messages 与死表死枚举，并修齐 4 个 bug，保证模块产品完备。**

> 范围声明：本里程碑做**存储收敛 + 功能修复**。代码符号 `run`→`span` 的物理改名在 `33d1e392` 已完成；本 spec 不再碰改名，只做合库 / 删表 / 修 bug。`events.db`→`backend.db` 是**物理合库**（两个 sqlite 文件合成一个），不是逻辑改名。

### 编号体系

- `Sn`：存储收敛项（合库 / 删表 / 删枚举 / 改表名）。
- `Bn`：`33d1e392` 遗留 bug 修复项。
- `Wn`：前端（web）改动项。
- `Phase n`：施工阶段，按依赖排，每个 = 一个可独立 review 的 PR。

---

## 1. 收敛目标（一句话锚点）

```text
存储库唯一切分依据 = 包归属，不是功能类别。
  · backend.db  = backend 包独占的全部表（领域真相 + 运维控制面）。events.db 7 表并入。
  · checkpointer.db = framework 包独占（线程工作态 checkpoint_messages/interrupts + 执行事实流 checkpoint_events）。
  · 三库 → 两库。

messages 唯一真源分层 = ledger（产品真相） + checkpoint_messages（框架工作态）。
  · projection_messages 第三份冗余删除（无写方无读方，仅一句孤儿 DELETE）。
  · 三份 → 两份。

死表死枚举清零 + 控制面表正名：
  · runner_health 表删除（runner daemon 时代残骸）。
  · run_ops_event.kind 枚举 15 → 3（projection_degraded / retry_requested / retry_started）。
  · run_ops_event 物理表名 → control_plane_event（S4，归属语义正名）。

33d1e392 带病点修齐：
  · B0 readonly 连接不再跑 WAL PRAGMA（去掉那行）。
  · B1 todo_update 接通 accumulator 赋值，appendTodo 不再空跑。
  · B2 前端详情页用 spanId 取数；列表按 session 聚合 span。
  · B3 合库 migration 人工核验，禁止 drop+recreate。
```

---

## 2. 产品动线（改动后的完整闭环，先讲产品再讲技术）

> 用户要求「保证模块的产品完备性」。本节定义改完后受影响的三条动线；§3 起的技术 Phase 都是为支撑这三条动线服务的。存储合库对用户**不可见**（动线不变），但它修复的 B0/B1/B2 直接决定动线能否跑通。

### 动线 A — 排障主线：sessions → session 详情（span 列表）→ span 瀑布【B2 修复后才闭合】

```text
/ops/sessions                  一行一条会话记忆线，按 sessionId 聚合
  每行：sessionId、归属 agent、状态、该 session 下的 span 数 / 累计成本 / 最近 span 时间
  ↓ 点一行
/ops/sessions/[sessionId]      这条记忆线的全档案
  ├─ 头部：当前状态、归属 agent、上下文
  ├─ span 列表：该 session 上一次次 prompt loop，每行 = 一个 span（一次输入→跑完）
  └─ ↓ 点一个 span
     span 瀑布（TraceWaterfall）：该 span 内 llm_call / tool_call / interrupt 时序
       数据源 = checkpoint_events WHERE session_id=? AND span_id=?
```

**B2 现状缺陷**：列表页 `sessions/page.tsx` 只 `listOpsRuns` 平铺 run，**没有 groupBy sessionId**——「一条记忆线收多个 span」的产品语义没实现；详情页 `sessions/[sessionId]/page.tsx:24` 把 `sessionId` 当 `spanId` 查，**详情必空**。本 spec 的 B2 + W 让这条动线真正闭合：列表按 session 聚合、详情页按 sessionId 取「该 session 的 span 列表」、点单个 span 才下钻到 span 详情/瀑布。

### 动线 B — 监控主线：Insights 图表【B0 修复后才不 500】

```text
/ops/sessions/[sessionId] 内嵌 RunInsightsPanel  →  GET ops/runs/:spanId/insights
  数据源 = checkpoint_events（readBySpan / readWindow）
```

**B0 现状缺陷**：`checkpoint-events-store.ts:17` 在 readonly 连接跑 `PRAGMA journal_mode=WAL`，连接一建立、首个查询一来就抛 `SQLITE_READONLY`——Insights 与详情页的事实流读取**全部 500**。删掉那一行即可（WAL 由写方 framework 侧设置，读方无需也无权设置）。

### 动线 C — 对话产品完备性：todo 投影【B1 修复后才不丢】

```text
对话中 agent emit todo_update  →  RunAccumulator.lastTodoUpdate  →  onRunComplete Phase 3 appendTodo
  ↓
todo 落到 conversation 的 todo 列表，用户在对话侧看得到
```

**B1 现状缺陷**：`acc.lastTodoUpdate` 从无赋值方，`projection.ts:218-220` 的 `appendTodo` 永远走不到——run 期间产生的 todo 全部丢失。修复：在消息投影链路里，识别 `todo_update` 事件并写入 `acc.lastTodoUpdate`（赋值点见 §6）。

> 存储合库（S1）本身对以上动线**零可见变化**——它是纯基础设施收敛。但它和 B0/B1/B2 同属一个「存储 + 观测完备性」里程碑，故合并交付。

---

## 3. Phase 1 — 修 33d1e392 功能 bug（`B0`/`B1`/`B2`，最高优先级，独立可发）

> 这三个 bug 是用户可感知的功能性故障（详情页空白 / Insights 500 / todo 丢失），与存储合库正交，应最先独立修复上线，不被合库的 migration 风险阻塞。

### 3.1 B0 — readonly 连接去掉 WAL PRAGMA

**病灶**：`main.ts:216` 以 readonly 打开 `checkpointer.db`：

```ts
const checkpointDb = new Database(`${config.dataDir}/checkpointer.db`, { readonly: true });  // :216
const checkpointEventsStore = createCheckpointEventsStore(checkpointDb);                     // :217
```

而 `createCheckpointEventsStore`（`checkpoint-events-store.ts:15-19`）：

```ts
export function createCheckpointEventsStore(db: Database): CheckpointEventsStore {
  db.exec("PRAGMA journal_mode=WAL");   // :17 ← readonly 连接执行写 PRAGMA → SQLITE_READONLY
  ...
}
```

**Before**：readonly 连接跑 `journal_mode=WAL`（DDL/写操作）→ 抛 `SQLITE_READONLY`，Ops 详情/Insights 全 500。
**After**：删除 `:17` 这一行。WAL 模式是数据库文件级属性，由**写方**（framework checkpointer 初始化时）设置一次即持久化到文件；读方只需 `{ readonly: true }` 打开即可正常读 WAL 库，无需也无权再设 journal_mode。

```ts
export function createCheckpointEventsStore(db: Database): CheckpointEventsStore {
  // WAL 由 framework 写方设置并持久化在 db 文件中；readonly 读方不得执行写 PRAGMA。
  function parseRows(...) { ... }
  ...
}
```

> 注：`main.ts:217` 的 readonly 连接保留——读写分离正确（run-loop 写、Ops 读同一物理表）。只是 readonly 连接绝不能跑写 PRAGMA。

### 3.2 B1 — todo_update 接通 accumulator

**病灶**：`projection.ts:30` 声明 `lastTodoUpdate`，`:50` 初始化 null，`:218-220` 消费它做 `appendTodo`——但**全仓无赋值方**（grep `lastTodoUpdate =` 零命中）。

**Before**：todo_update 事件流过投影链路但从不写入 `acc.lastTodoUpdate`，`appendTodo` 死代码。
**After**：在消息/事件投影回调里识别 `todo_update`，写入 accumulator：

```ts
// 投影回调（main.ts onRunMessage 或 projection 链路对应 todo_update 分支）
if (event.type === "todo_update") {
  const acc = getOrCreateAccumulator(spanId, senderMemberId);
  acc.lastTodoUpdate = { todos: event.todos };   // ← 新增赋值点，§6 plan 给精确落点
}
```

这样 `onRunComplete` Phase 3（best-effort）的 `appendTodo(cid, acc.senderMemberId, acc.lastTodoUpdate.todos)` 才有数据可写。

> 落点二选一（plan §6 定夺）：① framework 已把 `todo_update` 纳入 `checkpoint_events`，则投影侧从事实流读取；② 若 todo_update 只在 AgentEvent 流而不入 checkpoint_events，则在 `main.ts` 的 onRunMessage/onRunEvent 回调里赋值。**删除前唯一需二次确认点**：先核 `todo_update` 当前流经哪条回调。

### 3.3 B2 — 前端详情页 id 对齐 + 列表按 session 聚合

**病灶 1（详情页 id 错位）**：`sessions/[sessionId]/page.tsx:24`：

```ts
const { sessionId } = useParams<{ sessionId: string }>();           // :20
queryFn: () => api.getOpsRunDetail(sessionId),                       // :24 ← 把 sessionId 当 spanId
```

而 `getOpsRunDetail` → `ops/runs/:id` → `getRunDetail(spanId)` → `WHERE span_id = ?`（`service.ts:209-214`）。`sessionId ≠ spanId` → 详情必空。

**病灶 2（列表无聚合）**：`sessions/page.tsx:73-84` 只 `api.listOpsRuns({limit:100})` 平铺 run 行，无 groupBy sessionId——动线 A「session 顶层、span 收纳其下」未实现。

**修复方向**（与动线 A 对齐，二选一，plan 定夺）：

| 选项 | 详情页语义 | 后端 |
|------|-----------|------|
| **方案 ①（推荐，最小改）** | `/ops/sessions/[sessionId]` = 该 session 的 **span 列表**页；点某个 span 才进 `getRunDetail(spanId)` 的 span 详情 | 新增 `getSessionDetail(sessionId)` 聚合 `SELECT … FROM run WHERE session_id=?`；详情页改用它 |
| 方案 ②（重） | 详情页直接渲染「最近一个 span」详情 | 详情页先 `getRuns({sessionId})` 取最新 spanId，再 `getRunDetail(spanId)` |

推荐**方案 ①**：它让 URL 层级与产品本体（session ⊃ span）一致，且修复列表聚合（列表 groupBy sessionId 后，每行展开/下钻看 span 列表）。`RunInsightsPanel`（`page.tsx:59` 现传 `runId={sessionId}`）一并改为传**选中的 spanId**。

**回归点**：`http.ts` resume / detail 路由测试；前端 e2e「列表→session→span→瀑布」四级导航；`getSessionDetail` 单测（聚合多 span、成本累加）。

---

## 4. Phase 2 — 删第三份 messages：`projection_messages`（`S2`，独立小 PR）

### 4.1 病灶

`projection_messages`（`schema.ts:87-91`）与 `checkpoint_messages`（`checkpointers/schema.ts:3-7`）schema 逐字段相同：

```ts
// schema.ts:87 — projection_messages（待删）
export const projectionMessages = sqliteTable("projection_messages", {
  sessionId: text().primaryKey(),
  messages: text().notNull(),
  updatedAt: integer({ mode: "number" }).notNull(),
});
// checkpointers/schema.ts:3 — checkpoint_messages（保留，framework 工作态真源）
export const checkpointMessages = sqliteTable("checkpoint_messages", {
  sessionId: text().primaryKey(), messages: text().notNull(), updatedAt: integer(...).notNull(),
});
```

全仓引用核验：

- 写方：**零**。
- 读方：**零**。
- 唯一引用：`adapter-sqlite.ts:145-148` 删 conversation 时的孤儿清理 `db.run("DELETE FROM projection_messages WHERE session_id = ?", [tid])`。

`projection.ts:22-24` 注释：投影直读 ledger，eager 物化 thread_projection 是 M9 恢复路径残骸——已无人依赖。

### 4.2 修复

- 删表定义 `schema.ts:86-91`。
- 删孤儿清理 `adapter-sqlite.ts:145-148`（连注释）。
- 出 drizzle migration `DROP TABLE projection_messages`（§B3 核验：纯 DROP，无数据迁移，安全）。

**回归点**：`adapter-sqlite.test.ts`（若有删 conversation 测试，去掉 projection_messages 断言）；全仓 grep `projection_messages|projectionMessages` 归零。

---

## 5. Phase 3 — 删 runner 时代死表死枚举（`S3`，独立小 PR）

### 5.1 删 `runner_health` 表

`runner_health`（`events-schema.ts:94-105`）：`service.ts:10` 自承已移除，`RuntimeOpsStore` 零方法，全仓零读写。

- 删表定义 `events-schema.ts:94-105`。
- 出 migration `DROP TABLE runner_health`。

### 5.2 收窄 `run_ops_event.kind` 枚举 15 → 3

`types.ts:20-35` 列 15 个 kind，实际 emit 仅 3：

```ts
// before — types.ts:20（15 值，12 个死）
export type RunOpsEventKind =
  | "attempt_started" | "attempt_transport_seen" | "delta_pushed"
  | "run_done_received" | "run_finalized_sent" | "cancel_requested"
  | "abort_sent" | "reattach_started" | "reattach_succeeded" | "reattach_failed"
  | "reaper_marked_interrupted" | "projection_degraded" | "recover_requested"
  | "retry_requested" | "retry_started";

// after — 仅保留实际 emit 的 3 个
export type RunOpsEventKind =
  | "projection_degraded"  // supervisor.ts:157 — 关键 sink（ledger terminal write）失败
  | "retry_requested"      // scheduler.ts:139
  | "retry_started";       // scheduler.ts:152
```

> 注：`run_ops_event.kind` 列是 `text().notNull()`（`events-schema.ts:56`），DB 不带 CHECK 约束，所以收窄枚举**只改 TS 类型**，无需 migration，无历史数据风险（旧行若有死 kind 仍可读，只是不再产生）。

#### abort/cancel 本就无事件（grep 实证，非本 spec 引入的回归）

> 用户疑问：「现在 abort 没有事件了吗？」答案：**abort 从来就没有过 ops 事件**，删 `abort_sent` 枚举值不丢任何观测。

grep `appendRunEvent` 全部 emit 方仅 3 处，**没有任何一处是 abort/cancel 路径**：

| emit 点 | kind |
|---------|------|
| `scheduler.ts:137` | `retry_requested` |
| `scheduler.ts:150` | `retry_started` |
| `supervisor.ts:154` | `projection_degraded` |

`abort_sent` 在源码里只出现在两处 **HTTP 返回状态串**，都不写库：
- `service.ts:301-305` `cancel()` → `return { state: "abort_sent", ... }`（仅调 `supervisor.cancel()` 终止进程内 AgentSession，不 `appendRunEvent`）。
- `run-query-service.ts:137` 同款返回串。

即 `abort_sent` 在 15 值枚举时代也**从未被 emit** 进 `run_ops_event`——它是「runner daemon 给 reattach 看的中断信号」时代词汇，AgentSession 进程内执行后已无 reattach，故无 sink。删它属于清死代码，零观测损失。

> **产品完备性提示（留作决策，非本 spec 强制）**：当前 abort/cancel 这个用户动作**确实不产生任何控制面事件**——排障时序里看不到「谁在何时取消了这个 span」。若希望 cancel 可观测，应在 `cancel()` 成功后补一次 `appendRunEvent({ kind: "cancel_requested" })`，并把 `cancel_requested` 保留进收窄后的枚举（3 → 4）。这是新增功能，与「删死枚举」正交，是否做请明确。本 spec 默认按「删到 3 值」执行；若你要 cancel 可观测，我把它升级为 4 值并加 emit 点。

**回归点**：`store.test.ts` / `service.test.ts` 中引用死 kind 的断言删除；TS 编译。

### 5.3 物理重命名 `run_ops_event` → `control_plane_event`（`S4`）

> 用户决策：表名要改。`run_ops_event` 是「run 时代 + ops 信号」的双重历史包袱命名；收敛后它的语义就是**控制面事件**（projection 降级 / 重试调度），与「执行事实」`checkpoint_events`、「领域真相」`conversation_ledger` 三足分立。改名为 `control_plane_event` 让物理表名与归属语义一致。

**改动面（grep 实证，共 5 处代码 + ~15 处文档）：**

| 层 | 文件 | 改法 |
|----|------|------|
| schema | `events-schema.ts:50-65` | drizzle symbol `runOpsEvent` → `controlPlaneEvent`；`sqliteTable("run_ops_event", …)` → `"control_plane_event"`；3 个 index 名 `idx_run_ops_event_{span,trace,kind}` → `idx_control_plane_event_{span,trace,kind}` |
| store | `store.ts`（symbol `runOpsEvent` 用于 :14/73/82/90-92/100-102） | 引用名随 schema 改 |
| service | `service.ts` | 注释/类型引用随改（无表名字面量） |
| web | `TraceWaterfall.tsx:33` | 文档串 "run_ops_event data" → "control_plane_event data" |
| 文档 | data-model.md / overview.md / identifiers.md / system-overview.md + m16/m18.7/m20 等历史 spec/retro/plan | 见 §6.2 migration 同批改 |

**migration（关键，折叠进 S1 合库那一次）**：表名变更绝不能让 drizzle 产出 drop+recreate（丢数据），必须**手写 ALTER**：

```sql
ALTER TABLE run_ops_event RENAME TO control_plane_event;
-- index 随表迁移但名字仍是旧的，重建以保持命名一致：
DROP INDEX IF EXISTS idx_run_ops_event_span;
DROP INDEX IF EXISTS idx_run_ops_event_trace;
DROP INDEX IF EXISTS idx_run_ops_event_kind;
CREATE INDEX idx_control_plane_event_span  ON control_plane_event (span_id, seq);
CREATE INDEX idx_control_plane_event_trace ON control_plane_event (trace_id, seq);
CREATE INDEX idx_control_plane_event_kind  ON control_plane_event (kind, ts DESC);
```

> 折叠依据：S1 合库时 events 6 表本就要在 backend.db 重新 `CREATE TABLE`（空环境）或 `INSERT…SELECT` 搬运（保留环境）。改名在合库这一刻一次做完最省——空环境直接以新名建表（连 RENAME 都省，建表就叫 `control_plane_event`）；保留环境则先 RENAME 再搬。两路都不 drop 有数据表。详见 §6.2 / §6.4。

**历史文档处理原则**：`docs/superpowers/{specs,retros,plans}/` 下 m16/m18.7/m20 等**已归档的历史里程碑文档**记录的是当时事实，**不改**（改了会篡改历史记录）。只改**活文档**：`docs/architecture/` 下 4 篇（data-model / overview / identifiers / system-overview）+ 本 spec/plan。归档文档里的 `run_ops_event` 视为「该里程碑当时的表名」，保留。

**回归点**：全仓 grep `run_ops_event\|runOpsEvent` 仅余归档历史文档；`store.test.ts` 表名断言改新名；空库 + 有数据库两路冒烟，控制面事件读写正常。

---

## 6. Phase 4 — `events.db` 并入 `backend.db`（`S1`，存储收敛核心，依赖 B3 核验）

### 6.1 决策：按归属合库

`events.db` 7 表（`run` / `attempt` / `run_ops_event` / `run_origin` / `surface_health` / `issue_event`，删 `runner_health` 后 6 表）全部由 backend 包独占。无包边界 → 并入 `backend.db`，三库 → 两库。`checkpointer.db` 保留（framework 包独占边界）。

### 6.2 schema / migration 合并

| 步骤 | Before | After |
|------|--------|-------|
| schema 文件 | `schema.ts`（backend）+ `events-schema.ts`（events）两份 | `events-schema.ts` 的表定义并入 `schema.ts`（或 `schema.ts` re-export），单一 schema 源 |
| migration 目录 | `drizzle/backend` + `drizzle/events` 两套 | 统一 `drizzle/backend`；events 6 表的建表 SQL 进同一 migration 链 |
| drizzle config | `drizzle.backend.config.ts` + `drizzle.events.config.ts` | 删 `drizzle.events.config.ts`，backend config 覆盖全部表 |
| `gen-drizzle.sh:9-10` | 两条 generate | 删 events 那条（`:10`） |

### 6.3 运行时 wiring 合并（`main.ts`）

```ts
// before — main.ts:65-75
const db = openDb(`${config.dataDir}/backend.db`);          // :65
const eventsDb = new Database(`${config.dataDir}/events.db`); // :68
eventsDb.exec("PRAGMA journal_mode=WAL");                    // :69
eventsDb.exec("PRAGMA busy_timeout=5000");                   // :70
runEventsDbMigrations(eventsDb);                            // :71
const opsStore = new RuntimeOpsStore(eventsDb);             // :75

// after — 单一 backend 连接承载全部 backend 表
const db = openDb(`${config.dataDir}/backend.db`);  // openDb 已设 WAL + 跑 drizzle/backend migration（含原 events 6 表）
const opsStore = new RuntimeOpsStore(db);           // ← 同一连接
// 删 eventsDb、runEventsDbMigrations、events-db-migrations.ts
```

连带：

- `RuntimeOpsStore` 构造入参 `eventsDb` → `db`（同一 backend 连接）。`store.ts` 内部 SQL 表名引用随 S4 改名（`run_ops_event` → `control_plane_event`），物理同库。
- `SpanSupervisor` 构造的 `db: eventsDb`（`main.ts:89/229`）→ `db`。
- 删 `events-db-migrations.ts`（`features/span/events-db-migrations.ts`）+ `main.ts:52` 的 import。
- 关闭顺序（`main.ts:368` 附近）：原先要先停 cron 再让 supervisor 关 `eventsDb`；合库后只剩一个 `db.close()`，简化关闭序。
- `busy_timeout=5000`（原 `eventsDb` 专设）：`openDb` 已设 WAL + synchronous NORMAL；如需可在 `openDb` 内补 `PRAGMA busy_timeout`（合库后单连接，竞争更小，可选）。

> **数据迁移**：`backend.db` 与 `events.db` 是两个物理文件。合库不是 schema 改名，需要把 `events.db` 现有行搬进 `backend.db`。开发环境（gitignore 的 `.backend-data`，每人本地 `gen-drizzle.sh` 重建）可直接重建；若存在需保留的环境，plan 出**一次性数据搬运脚本**（`ATTACH events.db; INSERT INTO backend.run SELECT * FROM events.run; …`）。这是 §B3 核验的重点。

### 6.4 B3 — migration 安全核验（贯穿 S1/S2/S3/S4）

drizzle-kit 列改名/合表/改表名可能产出 drop+recreate（丢数据）。本里程碑所有 migration 必须**人工核验生成的 SQL**：

- `DROP TABLE projection_messages` / `DROP TABLE runner_health`：纯 DROP，无数据保留需求 → 安全。
- events 6 表建表 + 数据搬运：确认是 `CREATE TABLE` + `INSERT … SELECT`，**不是**对既有 backend 表的 drop+recreate。
- **S4 表名变更**：空环境直接以新名 `control_plane_event` 建表（无需 RENAME）；保留环境用手写 `ALTER TABLE run_ops_event RENAME TO control_plane_event` + 重建 3 个 index（见 §5.3），**绝不**让 drizzle 产 drop+recreate。
- 禁止任何对 `conversation_ledger` / `checkpoint_*` 等有数据表的 drop+recreate。

**回归点**：migration 生成后 `bunx drizzle-kit generate` diff 审查；空库 + 有数据库两路启动冒烟；`store.test.ts` 注入单一 `db` 连接。

---

## 7. 施工顺序与 PR 切分

```text
PR-1  Phase 1  修 B0/B1/B2（readonly PRAGMA / todo_update / 前端 id 对齐 + 列表聚合）  ← 最高优先级，用户可感知 bug，独立可发
PR-2  Phase 2  删 projection_messages（S2）+ migration DROP                          ← 独立小 PR
PR-3  Phase 3  删 runner_health（S3）+ 收窄 run_ops_event.kind 15→3 + 改表名 control_plane_event（S4）  ← 独立小 PR
PR-4  Phase 4  events.db 并入 backend.db（S1）+ 数据搬运脚本 + B3 核验                ← 存储收敛核心，最后做（爆炸面最大）
```

**依赖**：PR-1 / PR-2 / PR-3 彼此解耦，可并行；PR-4 建议最后（合库要动 schema 文件、main.ts wiring、migration，与 S2/S3/S4 的 DROP/RENAME 同库，合并到 PR-4 一并核验 migration 更省一次 drizzle 重生成）。

> 备选合并策略（plan 采纳）：S2（删 projection_messages）+ S3（删 runner_health + 收窄枚举）+ S4（改表名）+ S1（合库）都触碰 schema / migration，合成**一个** PR（一次 `drizzle-kit generate` 出齐 DROP + RENAME + 合表），减少重复重生成 migration 的成本。S4 在合库 migration 里若是空环境直接以新名建表，连 RENAME 都省。

### 延后项（显式不在本里程碑）

- **`run`→`span` 物理改名**：`33d1e392` 已完成，无残留。
- **`checkpointer.db` 也并入 backend.db**：**不做**——framework 包独占是真边界，合并会破坏包边界（这正是本 spec 区分「按归属拆」与「按功能拆」的反例）。
- **sessionId 格式统一 `:owner`→`:${agentId}`**：与本存储里程碑正交，留 backlog。

---

## 8. 验收标准

功能（用户可感知，B 项）：
- [ ] **B0**：Ops 详情页 / RunInsights 加载不再 500；readonly 连接不执行 WAL PRAGMA。
- [ ] **B1**：run 期间 agent emit 的 todo_update 落进 conversation todo 列表，不再丢失。
- [ ] **B2**：`/ops/sessions` 按 session 聚合（一行一 session，含 span 数/成本）；`/ops/sessions/[sessionId]` 展示该 session 的 span 列表；点单个 span 下钻到 span 详情/瀑布，数据非空。

存储收敛（S 项）：
- [ ] **S1**：`events.db` 6 表并入 `backend.db`；运行时只开 `backend.db` + `checkpointer.db` 两个连接；`events-db-migrations.ts` / `drizzle.events.config.ts` 删除。
- [ ] **S2**：`projection_messages` 表 + `adapter-sqlite.ts:148` 孤儿 DELETE 删除；migration 含 `DROP TABLE projection_messages`；全仓 grep 归零。
- [ ] **S3**：`runner_health` 表删除（含 migration DROP）；`run_ops_event.kind` 枚举收窄到 3 个。
- [ ] **S4**：`run_ops_event` 物理表名改 `control_plane_event`（含手写 RENAME + 重建 3 index）；活文档（`docs/architecture/` 4 篇）同步；全仓 grep `run_ops_event\|runOpsEvent` 仅余归档历史里程碑文档。

migration 安全（B3）：
- [ ] 所有生成的 migration SQL 经人工核验，无对有数据表的 drop+recreate；events 数据搬运为 `INSERT … SELECT`。
- [ ] 空库 + 有数据库两路启动冒烟通过。

---

## 9. 关联

- 架构页 [`foundations/facts-and-projections.md`](../../architecture/foundations/facts-and-projections.md) —— 事实流归属 checkpointer / 投影归属 ledger 的边界（projection_messages 删除依据）
- 架构页 [`foundations/identifiers.md`](../../architecture/foundations/identifiers.md) —— session=trace / span=prompt loop（B2 列表聚合依据）
- 架构页 [`backend/event-log.md`](../../architecture/backend/event-log.md) —— EventLog tombstone（死表清理脉络）
- 配套 plan `2026-06-27-storage-convergence-plan.md` —— 函数签名伪代码 + 数据搬运脚本 + 测试改造
- 上一轮 spec [`2026-06-27-observability-convergence.md`](./2026-06-27-observability-convergence.md) —— 观测面收敛（本 spec 的前置，基准 HEAD `33d1e392` 即其实现提交）



