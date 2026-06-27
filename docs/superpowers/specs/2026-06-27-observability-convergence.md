# 观测面收敛：执行事实流回归 checkpointer + 路由对齐 session

> 状态：实施 spec（含逐项 before/after、文件行号、产品动线、回归点、分阶段 PR）
> 基准 HEAD：`1dbe60c`（`docs/architecture/foundations/identifiers.md` 描述的目标模型的**部分**已落地）
> 所有 `file:line` 均基于 HEAD 工作树核验，非 dist/.turbo 残留。
> 上游依据：架构页 [`foundations/identifiers.md`](../../architecture/foundations/identifiers.md)（id 目标模型）+ [`backend/event-log.md`](../../architecture/backend/event-log.md)（EventLog tombstone）+ [`foundations/facts-and-projections.md`](../../architecture/foundations/facts-and-projections.md)（事实流归属 checkpointer）。文档已先行收敛，本 spec 把代码追上文档。

---

## 0. 出发点：存储层已收敛，观测层断了

上一轮（`identifiers-and-di-convergence`）把**存储侧**的 id 体系落地了。HEAD 核验，这些已经是事实：

- `run.sessionId` 列已正名（`events-schema.ts:12/17` 注释 `PR-6: threadId renamed to sessionId`）。
- `attempt` 表 PK 已是复合 `(runId, seq)`，`attemptId` 列已删（`events-schema.ts:30-46`）。
- `run_ops_event.attemptSeq` 已是 integer（`events-schema.ts:56-57`）。
- `SessionFactory` 已落地：`getOrCreate(sessionId, spec)` 复用 + `enqueuePrompt` 串行化 + idle reaper（`session-factory.ts:41-205`）。
- `executeAgentRun` 已重构成 `RunDeps`/`RunRequest`/`RunOrigin`、经 `sessionFactory.getOrCreate` + `enqueuePrompt`、返回 `{ runId, attemptSeq }`（`run-executor.ts:84-183`）。

**但观测面（Ops）没跟上，而且断在三个地方：**

1. **resume 永远 404**：`resumeRoute`（`http.ts:18`）从 `session-registry.ts` 的内存 map 里 `getSession(runId)` 取 session——而这张 map **已无任何写入方**（`registerSession` 零调用，被 `SessionFactory` 取代）。人工审批门（ToolApprovalCard）点「批准」必 404，**人审闭环彻底断了**。
2. **Ops 读死表**：`runtime-ops/service.ts:163/236` 与 `insights.ts:108/246/250` 仍 `SELECT … FROM event_log` / `eventLog.read(...)`。而 `event_log` 表**已无生产写入方**（全仓无 `.append()` 调用，runner daemon 删除后成死表，见 [event-log.md](../../architecture/backend/event-log.md)）。结果：**run 详情、TraceWaterfall、RunInsights 全部空白**——「No diagnostic events recorded」是常态，不是异常。
3. **真正的执行事实流没人读**：framework run-loop 把 tool_start/tool_end/model_end 写进 checkpointer 的 `checkpoint_events`（`run-loop.ts` 7 处 `appendEvent`、`execute-one.ts` 6 处、`create-agent.ts` 2 处），这是**唯一活着的事实流**——但它 ① 按 `threadId` 切、没有 spanId 维度（`schema.ts:19`），无法「按一次 prompt loop 回看」；② 接口仍标 `@deprecated`（`checkpointer.ts:54/59`）；③ 事件词汇（`model_end` 只有 `blocks`+`usage`，`run-loop.ts:150-155`）比 Ops 需要的 `llm_call`（含 model/latencyMs/ttftMs/step，`run-loop.ts:157-172`）**少了一半字段**。

一句话：**存储侧的 id 收敛已完成，观测侧还在指着 runner 时代的死表，而活着的事实流既缺 span 维度又缺字段。本 spec 把观测面接到活事实流上，并顺势把路由从 run 粒度收敛到 session 粒度。**

> 范围声明：本里程碑只做**功能修复 + 观测收敛**。代码符号 `run`→`span` 的物理改名（`runId`→`spanId`、`RunSupervisor`→`SpanSupervisor`）与前端 runId→spanId 字段名改名属于**纯改名**，收益低、爆炸面大，**显式延后**到后续里程碑（见 §9 延后项）。本 spec 一律沿用代码现名 `runId`，但在产品语义上它就是 `spanId`（一次 prompt loop）。

### 编号体系

- `Pn`：功能修复项（resume / 观测读写 / 事实流维度）。
- `Wn`：前端（web）改动项。
- `Rn`：路由收敛项。
- `Phase n`：施工阶段，按依赖排，每个 = 一个可独立 review 的 PR。

---

## 1. 收敛目标（一句话锚点）

```text
执行事实流唯一真源 = checkpointer 的 checkpoint_events（按 sessionId + spanId 切）。
  · run-loop 经 appendEvent(sessionId, spanId, event) 写；Ops 经 readEvents(sessionId, spanId) 读。
  · event_log 表 / EventLog / sqliteEventLog / inMemoryEventLog / supervisor.onRunEvent 全部删除。
  · checkpoint_events 加 spanId 列；CheckpointEvent 词汇补齐 Ops 所需字段（model/latencyMs/ttftMs/step）。

人审闭环修复 = resume 经 DB 反查 runId→sessionId，向 SessionFactory 拿活 session。
  · 删除 orphaned session-registry.ts。

路由收敛 = /ops/runs → /ops/sessions；session 详情聚合该 session 下多个 span；删 /ops/traces。
  · 「session = 一条 trace」与 OTel 的 run_origin.traceId 二选一，统一到 session 本体。
```

---

## 2. 产品动线（改动后的完整闭环，先讲产品再讲技术）

> 用户要求「保证模块的产品完备性」「改动后的产品动线会是怎么样的」。本节定义改完后 Ops 控制台的三条核心动线；§3 起的技术 Phase 都是为支撑这三条动线服务的。

### 动线 A — 排障主线：sessions → session 详情 → span 列表 → span 瀑布

```text
/ops/sessions                  一条会话记忆线一行（sessionId = ${上下文}:${agentId}）
  状态：活跃 / 空闲 / 等待审批；最近 span 时间；累计 span 数 / 成本
  ↓ 点一行
/ops/sessions/[sessionId]      这条记忆线的全档案
  ├─ 头部：当前状态（running/waiting/idle）、归属 agent、上下文（哪个 conversation/issue/cron）
  ├─ span 列表：这条 session 上一次次 prompt loop（现 runId），每行 = 一次输入→跑完
  │    每个 span 显示：触发源、起止、终态、attempt 次数、llm/tool 调用数、成本
  └─ ↓ 点一个 span
     span 瀑布（复用 TraceWaterfall）：该 span 内 llm_call / tool_call / interrupt 时序
       数据源 = checkpoint_events WHERE sessionId=? AND spanId=?（活事实流，不再空白）
```

**关键变化**：现状 `/ops/runs` 把每个 run 平铺成一行，用户看不出「哪些 run 属于同一条记忆线」；收敛后 session 是顶层实体，span 收在 session 下——这正对齐 OTel「一条 trace 由多个 span 组成」，也对齐 [identifiers.md](../../architecture/foundations/identifiers.md) 的本体模型。

### 动线 B — 监控主线：agents 运行时健康（保留，数据源切换）

```text
/ops/agents → /ops/agents/[agentId]   每个 agent 的 surface health / 在跑 session 数 / 成本趋势
  RunInsights 图表（token 趋势 / 成本 / top tools）数据源从 event_log 切到 checkpoint_events
```

此动线交互不变，**只换数据源**——现状图表因读死表而空白，切换后才有数据。

### 动线 C — 人审闭环：ToolApprovalCard → resume → 继续/再次等待

```text
对话中 agent 触发审批 → 前端 ToolApprovalCard → POST /api/runs/:runId/resume
  ↓ 后端（修复后）
  runId --DB查--> sessionId --SessionFactory--> 活 session.resume({approved})
  ↓
  approved=true  → span 继续跑，事实流续写同一 (sessionId, spanId)
  approved=false → span 终止
  再次命中审批 → session 回到 waiting，闭环可重复
```

此动线**现状完全断裂**（必 404），P1 修复后才闭合。这是本里程碑**优先级最高**的一项——它是用户可感知的功能性 bug，不是观测优化。

---

## 3. Phase 1 — 修复 resume 人审闭环（`P1`，最高优先级）

### 3.1 病灶

`resumeRoute`（`http.ts:10-33`）：

```ts
import { getSession, removeSession } from "./session-registry.js";  // :3
...
const session = getSession(runId);                                   // :18 ← 空 map
if (!session) return json({ error: "Session not found …" }, 404);    // :19 ← 永远命中
```

`session-registry.ts` 的 `registerSession(runId, session)`（`:7`）**全仓零调用**（`grep` 确认只有定义、无调用方）——它是 per-run session 时代的产物，已被 `SessionFactory`（按 sessionId 索引）取代，但 resume 路由没跟着迁移。`main.ts:50` 还 import 了它的 `disposeSession`（同样无实际效用）。

### 3.2 修复

resume 需要的是「这个 runId 属于哪条 session 的活 AgentSession」。runId→sessionId 的映射在 `run` 表里就有（`run.sessionId`，`events-schema.ts:17`）；活 session 在 `SessionFactory` 里。所以：

**Before**：registry 查 runId → 404。
**After**：DB 反查 runId→sessionId → SessionFactory 取活 session → resume。

```ts
// resumeRoute 改为依赖注入 SessionFactory + run 查询
export function resumeRoute(deps: {
  sessionFactory: SessionFactory;
  getSessionIdByRunId: (runId: string) => string | null;   // 走 opsStore / run 表
}) {
  return async (req, runId) => {
    const sessionId = deps.getSessionIdByRunId(runId);
    if (!sessionId) return json({ error: "Run not found" }, 404);
    const session = deps.sessionFactory.peek(sessionId);     // ← 见 §3.3 新增 peek
    if (!session) return json({ error: "Session no longer active — already settled" }, 409);
    await session.resume({ approved, message });
    return json({ runId, resumed: true }, 202);
  };
}
```

> 语义校正：resume 不再 `dispose` session（现 `http.ts:24-27` 的 `if (state !== "waiting") dispose()` 是 per-run 时代逻辑）。session 跨 span 持久，归 SessionFactory 的 reaper / 显式 close 管，resume 路由不插手生命周期。

### 3.3 SessionFactory 新增只读 `peek`

`SessionFactory` 当前只有 `getOrCreate`（会 materialize 新建）——resume 不该「没有就造一个」（造出来的是空 session，resume 无意义）。新增只读探针：

```ts
// session-factory.ts SessionFactory 接口新增
/** 取已存在的活 session；不存在返回 undefined（绝不新建）。 */
peek(sessionId: string): AgentSession | undefined;
```

### 3.4 删除 orphaned registry

`session-registry.ts` 整文件删除；`main.ts:50` 的 `disposeSession` import 与调用点删除（改由 `sessionFactory.dispose` / `disposeAll` 承担）。

**回归点**：`http.ts` resume 测试需注入 fake SessionFactory + fake runId→sessionId 映射；端到端审批闭环测试（approved=true 续跑、approved=false 终止、二次 waiting）。

---

## 4. Phase 2 — checkpoint_events 加 span 维度 + 词汇补齐（`P3`，观测的地基）

> P2（Ops 读活事实流）依赖 P3 先把事实流变得「可按 span 切」且「字段够用」，故 P3 排在 P2 前。

### 4.1 加 spanId 列

`checkpoint_events`（`schema.ts:15-24`）当前无 spanId：

```ts
// before（schema.ts）
export const checkpointEvents = sqliteTable("checkpoint_events", {
  id: integer().primaryKey({ autoIncrement: true }),
  threadId: text().notNull(),
  event: text().notNull(),
  ts: integer({ mode: "number" }).notNull(),
}, (t) => [index("idx_checkpoint_events_thread").on(t.threadId, t.id)]);

// after —— 加 spanId（= 现 runId），切片维度
{
  id: integer().primaryKey({ autoIncrement: true }),
  sessionId: text().notNull(),              // threadId 正名（与 events.db 的 run.sessionId 对齐）
  spanId: text(),                            // 一次 prompt loop；nullable 兼容旧行
  event: text().notNull(),
  ts: integer({ mode: "number" }).notNull(),
}, (t) => [index("idx_checkpoint_events_span").on(t.sessionId, t.spanId, t.id)]);
```

### 4.2 spanId 流进 appendEvent

`appendEvent` 现签名 `appendEvent(sessionId, event)`（`checkpointer.ts:57`），调用点全用 `rt.thread.id`（run-loop 7 处 / execute-one 6 处 / create-agent 2 处）。改为带 spanId：

```ts
// checkpointer.ts
appendEvent(sessionId: string, spanId: string | undefined, event: CheckpointEvent): Promise<void>;
readEvents(sessionId: string, opts?: { spanId?: string }): AsyncIterable<CheckpointEvent & { spanId: string | null; ts: number }>;
```

spanId 从 `rt.runId`（run-loop 已有，`run-loop.ts:178` 等用它）取——`rt.runId` 正是 backend 经 `prompt(input, { runId })` 透传进来的当次 span。所以 13 处 `appendEvent?.(rt.thread.id, {...})` → `appendEvent?.(rt.thread.id, rt.runId, {...})`。

### 4.3 词汇补齐（关键，否则 Ops 读到的事实流缺字段）

Ops 的 `insights.ts` 期望 `llm_call` 事件携带 `{ step, model, usage, latencyMs, ttftMs, stopReason }`（`insights.ts:7-14`），`tool_call` 携带 `{ step, name, latencyMs, isError }`（`:16-22`）。这些字段 run-loop **已经算出来了**——但只 `yield` 给 AgentEvent 流（`run-loop.ts:157-172`），写进 `checkpoint_events` 的 `model_end` 只剩 `{ blocks, usage }`（`:150-155`）。

收敛要求 `CheckpointEvent` 成为**唯一**事实流，所以它必须承载这些字段。改 `CheckpointEvent`（`checkpointer.ts:20-43`）：

```ts
// model_end 补 model/latencyMs/ttftMs/step/stopReason —— 与 run-loop yield 的 llm_call payload 对齐
| { type: "model_end"; blocks: ContentBlock[]; usage?: Usage;
    model: string; step: number; latencyMs: number; ttftMs?: number; stopReason?: string; ts: number }
// tool_end 补 step/name/isError —— 与 tool_call payload 对齐
| { type: "tool_end"; result: ToolResultBlock; durationMs: number;
    step: number; name: string; isError: boolean; ts: number }
```

写入点（`run-loop.ts:150` model_end、`execute-one.ts` tool_end）把这些已有的局部变量一并写进事件。

> 第一性原理：`checkpoint_events` 本就该是「session 的完整运行档案」（[facts-and-projections.md](../../architecture/foundations/facts-and-projections.md)）。它字段不全，是因为历史上 audit 走 EventLog、checkpoint_events 只做恢复——现在两者合一，字段自然要补齐到 audit 够用。

**回归点**：`file-checkpointer.test.ts:63-67` / `in-memory.test.ts:43-47` 的 appendEvent roundtrip 加 spanId 入参；`create-agent.test.ts:906/944` 的 appendEvent 断言；checkpointer 三实现（sqlite/file/in-memory）的 `appendEvent`/`readEvents` 同步改签名。

---

## 5. Phase 3 — Ops 读 checkpoint_events（`P2` + `W-a`，点亮观测面）

### 5.1 Ops 直连 checkpointer.db（决策 b：读写分离，不破包边界）

> 用户拍板：「不是破坏了包边界，想象一下如果基础设施是 mysql，不过是一个读，一个写罢了。」run-loop 是写方，Ops 是读方，二者读写同一张物理表，是正常的基础设施共享，不是模块越界。

`runtime-ops` 新增一个只读的 checkpoint_events 访问器（直连 `checkpointer.db`，与 run-query-service 直连 events.db 同构）：

```ts
// runtime-ops/checkpoint-events-store.ts（新增）
export interface CheckpointEventsStore {
  /** 一个 span 的事实流（排障详情用） */
  readBySpan(sessionId: string, spanId: string): CheckpointEventRow[];
  /** 一条 session 的全部事实流（session 详情用） */
  readBySession(sessionId: string): CheckpointEventRow[];
  /** 时间窗口扫描（监控汇总用，替代现 eventLog.read({limit}) 全表扫） */
  readWindow(from: number, to: number): CheckpointEventRow[];
}
```

### 5.2 三个读点切换

| 读点 | Before | After |
|------|--------|-------|
| `service.ts:163` 最近事件类型（listRuns 行） | `SELECT … FROM event_log WHERE run_id=?` | `checkpointEventsStore.readBySpan(sessionId, runId)` 取末项 |
| `service.ts:236` getRunDetail 最近事件 | 同上 | 同上 |
| `insights.ts:108/246/250` RunInsights | `eventLog.read({runId})` | `checkpointEventsStore.readBySpan / readWindow` |

insights 的 `runId` 即 spanId；它需要的 `llm_call`/`tool_call` 现在能从补齐后的 `model_end`/`tool_end` 重建（§4.3）。`isLlmCall`（`insights.ts:75`）等判别器改为认 `model_end`/`tool_end` 并映射出 `model/latencyMs/...`。

> 注意：`run_ops_event` 表是**活的**（`supervisor.ts:158` 写 `projection_degraded`，`cron/scheduler.ts:134/147` 写重试事件），它承载的是**控制面事件**（attempt_started/reattach/cancel/retry，`types.ts:20-39`），不是执行事实流。两者不混：控制面事件留 `run_ops_event`，执行事实流（llm/tool）走 `checkpoint_events`。Ops 详情页把两条流按时间合并展示。

### 5.3 W-a：清除 attemptId 残留（顺手做）

存储层 attemptId 已删，但 runtime-ops API 层仍有「Phase 0 过渡尾巴」——自我赋值 + String 化的死字段：

| 残留 | 位置 | 改法 |
|------|------|------|
| `attemptId: string` + `attemptSeq: string`（注释 "same value as attemptId"） | `service.ts:43-45` | 删 `attemptId`，`attemptSeq: number` |
| `attemptId: …; attemptSeq: …` 联合 | `service.ts:82/89` | 删 `attemptId` |
| `attemptId: a.seq?.toString()` + `attemptSeq: a.seq?.toString()` | `service.ts:263-264` | 删 `attemptId`，`attemptSeq: a.seq`（number 不 String） |
| `attemptId: String(session.attemptSeq)` | `service.ts:307-308` | 删 `attemptId`，`attemptSeq: number` |
| `attemptId: string\|null` + `attemptSeq: string\|null` | `service.ts:393-394` | 删 `attemptId`，`attemptSeq: number\|null` |
| `attemptSeq: e.attemptId`（自赋值） | `service.ts:410-411` | `attemptSeq: e.attemptSeq` |
| `attemptId: r.attemptSeq?.toString()` | `store.ts:18-19` | 删 `attemptId` |
| `attemptId?: string` 入参 | `store.ts:68` | 删 |
| `@deprecated attemptId` + `attemptSeq: string` | `types.ts:40-42` | 删 `attemptId`，`attemptSeq: number\|null` |

前端连带：`api.ts:432/481/488/495` 的 `attemptId` 类型删除，`resumeRun` 返回（`api.ts:224`）的 `{ runId, attemptId }` → `{ runId, resumed }`（与 P1 后端返回对齐）；`TraceWaterfall.tsx:93` 的 `attemptId` 显示 → `attempt #${attemptSeq}`。

**回归点**：`store.test.ts` / `insights.test.ts` 的 attemptId 断言；前端类型编译。

---

## 6. Phase 4 — 删 event_log 死链（`P6`，收口）

P2 切完后，`event_log` / `EventLog` 再无读方（写方早已没有）。全部删除：

- `apps/backend/src/features/event-log/index.ts` 整目录删（`EventLog` / `EventSink` / `EventSource` / `sqliteEventLog` / `inMemoryEventLog` / `EventRecord`）。
- `events-schema.ts:109-121` `event_log` 表定义删 + 出一支 drizzle migration `DROP TABLE event_log`。
- `main.ts:38/74` `sqliteEventLog` import 与 `const eventLog = …` 删。
- `main.ts:178-191` `supervisor.onRunEvent(...)` 回调删（runner 时代残骸，注释自承 "Observability is handled by the EventLog append in supervisor"——而那个 append 早没了）。
- `supervisor.ts:37-41/236-239` 的 `#onRunEvent` 字段 + `onRunEvent()` 注册方法删（无人再依赖逐事件钩子）。
- `RuntimeOpsService` 的 `eventLog: EventLog` 依赖（`service.ts:98/102`）删，换 `checkpointEventsStore`。
- checkpointer 接口 `appendEvent`/`readEvents` 去掉 `@deprecated`（`checkpointer.ts:54/59`）——它们升级为一等能力；`@deprecated` 注释「UX 投影一律走 EventLog」已是反向事实，删。

> 注意保留 `todo_update` 处理：`main.ts:178` 的 onRunEvent 回调里有一段把 `todo_update` 累积进 accumulator 的逻辑（`:181-189`）。删 onRunEvent 前要确认 todo_update 投影另有去处或确认已废弃——**这是删除前唯一需要二次确认的点**，plan §6 会单列核查步骤。

**回归点**：`event-log/index.test.ts` 删；`supervisor.test.ts` 去掉 onRunEvent 相关；全仓 `grep event_log|EventLog|onRunEvent` 归零（除 tombstone 文档）。

---

## 7. Phase 5 — framework 侧 sessionId 正名收尾（`P5`）

events.db 侧 `sessionId` 已正名，但 framework / checkpointer 侧仍叫 `threadId`：

- `schema.ts:4/10/19` 三表的 `threadId` 列 → `sessionId`（§4.1 已含 checkpoint_events，这里补 checkpoint_messages / checkpoint_interrupts）。
- `run-loop.ts` / `execute-one.ts` / `create-agent.ts` 的 `rt.thread.id` 作为 sessionId 传入——变量名 `thread` 可留（它确实是 framework 内部的「线程」运行时对象），但**面向 checkpointer 的入参语义注释**标明即 sessionId。
- checkpointer 接口入参已是 `sessionId`（`checkpointer.ts:46` 注释已正名），sqlite/file/in-memory 三实现的内部变量名（`sqlite-checkpointer.ts:91` `threadId` 形参）同步。

> 这一项是纯命名收尾，与 P3 的 schema 改动同库，建议合进同一 PR（改 schema 时一并改列名），避免两次碰 checkpointer.db migration。

---

## 8. Phase 6 — 路由收敛 runs → sessions（`R1` + `W-b` 部分）

### 8.1 路由调整

```text
/ops/runs           → /ops/sessions            （顶层列 session，不再平铺 run）
/ops/runs/[runId]   → /ops/sessions/[sessionId] （session 详情，内含 span 列表 + span 瀑布）
/ops/traces/*       → 删除                       （session 即 trace，不再独立 trace 视图）
```

`run_origin.traceId`（OTel 风，`events-schema.ts:79`）与「session = trace」冲突。收敛方向：**session 是 trace 本体**，traceId 列保留作底层关联键但不再有独立 UI 入口（`/ops/traces` 删）。`TraceWaterfall` 组件**保留并复用**——它本就是「一组按时序排列的执行事件」的渲染器，搬到 span 详情下，喂 `checkpoint_events` 数据。

### 8.2 前端改点

| 文件 | Before | After |
|------|--------|-------|
| `app/(main)/ops/runs/` | 目录 | rename → `ops/sessions/`，列表 query 改 `groupBy sessionId` |
| `app/(main)/ops/runs/[runId]/page.tsx` | run 详情 | → `ops/sessions/[sessionId]/page.tsx`，聚合 span 列表 |
| `app/(main)/ops/traces/` | trace 视图 | 删 |
| `HealthSummary.tsx:59/61/67` | `href: /ops/runs?…` | `/ops/sessions?…` |
| `RunOpsTable.tsx:133` | `/ops/runs/${r.runId}` | `/ops/sessions/${r.sessionId}`（或 span 锚点） |
| `RunDiagnosisHeader.tsx:63` | `/ops/traces/${traceId}` | 删该链接 |
| `TraceWaterfall.tsx:80/114` | `/ops/runs/${e.runId}` | span 锚点（同 session 内跳转） |
| `IssueDetailSheet.tsx:88` | `/ops/runs/${run.runId}` | `/ops/sessions/${sessionId}#span-${runId}` |

> `W-b`（前端 runId→spanId **字段名**改名）只做**路由与 URL 语义**这一层（runs→sessions）；DOM 里 `runId` 变量名、API 字段名的物理改名跟随后续 `run→span` 里程碑，避免本里程碑爆炸面过大。本 Phase 的前端改动聚焦「动线跑通」，不追求符号洁癖。

**回归点**：所有 `/ops/runs`、`/ops/traces` 的 Next.js 路由链接；面包屑（`ops/sessions/[sessionId]/page.tsx` 的 Breadcrumb）；e2e 导航测试。

---

## 9. 施工顺序与 PR 切分

```text
PR-1  Phase 1  resume 修复（P1）+ SessionFactory.peek + 删 session-registry      ← 最高优先级，独立可发
PR-2  Phase 2  checkpoint_events 加 spanId + CheckpointEvent 词汇补齐（P3）+ §7 列名正名（P5）  ← 观测地基
PR-3  Phase 3  Ops 读 checkpoint_events（P2）+ 清 attemptId 残留（W-a）           ← 依赖 PR-2
PR-4  Phase 4  删 event_log/EventLog/onRunEvent 死链（P6）                        ← 依赖 PR-3（读方切完才能删）
PR-5  Phase 6  路由收敛 runs→sessions + 删 /ops/traces（R1/W-b 部分）             ← 依赖 PR-3（详情页要有数据）
```

**强依赖**：PR-2 → PR-3 →（PR-4 / PR-5）。PR-1 与其余解耦，可最先并独立上线（它是用户可感知的功能 bug 修复）。

### 延后项（显式不在本里程碑）

- **`run`→`span` 全仓物理改名**：`runId`→`spanId`、`RunSupervisor`→`SpanSupervisor`、`run-executor`→`span-executor`、`run_origin`→`span_origin`、前端所有 `runId` 变量/字段名。纯改名、爆炸面覆盖 backend+web+framework，收益是「名字对齐追踪词汇」。**功能完成后单独做**（用户决策 4：「在功能完成后同意做」）。
- **sessionId 格式统一 `:owner`→`:${agentId}`**：属上一轮 spec 的 ID#5，HEAD 未落地的话仍在 backlog，但与本观测里程碑正交，不在此处。

---

## 10. 验收标准

功能（用户可感知）：
- [ ] 对话审批 → ToolApprovalCard 点批准 → run 继续跑（resume 不再 404）；拒绝 → 终止；二次审批可重复。
- [ ] run/session 详情页、TraceWaterfall、RunInsights 不再空白——显示真实的 llm_call/tool_call 时序与 token/成本。

观测收敛：
- [ ] `checkpoint_events` 有 `spanId` 列，可按 `(sessionId, spanId)` 切片回看单个 span。
- [ ] `CheckpointEvent.model_end`/`tool_end` 携带 Ops 所需全字段（model/latencyMs/ttftMs/step/name/isError）。
- [ ] Ops 经只读 store 直连 checkpointer.db 读事实流；不再 `SELECT FROM event_log`。
- [ ] `event_log` 表 / `EventLog` / `sqliteEventLog` / `inMemoryEventLog` / `supervisor.onRunEvent` 全仓删除（含 migration DROP TABLE）。
- [ ] `appendEvent`/`readEvents` 去 `@deprecated`，成 checkpointer 一等能力。
- [ ] runtime-ops 无 `attemptId` 残留字段，`attemptSeq` 为 number。

路由：
- [ ] `/ops/sessions` 列 session、`/ops/sessions/[sessionId]` 聚合 span 列表 + span 瀑布；`/ops/runs`、`/ops/traces` 不再可达。
- [ ] `session-registry.ts` 删除。

---

## 11. 关联

- 架构页 [`foundations/identifiers.md`](../../architecture/foundations/identifiers.md) —— session=trace / span=prompt loop 的 id 目标模型
- 架构页 [`backend/event-log.md`](../../architecture/backend/event-log.md) —— EventLog tombstone（死表由来）
- 架构页 [`foundations/facts-and-projections.md`](../../architecture/foundations/facts-and-projections.md) —— 执行事实流归属 checkpointer 的边界
- 配套 plan `docs/superpowers/plans/2026-06-27-observability-convergence-plan.md` —— 函数签名伪代码 + 测试改造
- 上一轮 spec [`2026-06-26-identifiers-and-di-convergence.md`](./2026-06-26-identifiers-and-di-convergence.md) —— 存储侧 id 收敛（本 spec 的前置）
