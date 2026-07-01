# 观测面收敛 plan：执行事实流回归 checkpointer + 路由对齐 session

> 状态：实施 plan（逐步可执行，含函数签名伪代码、测试改造、test DI 重建）
> 基准 HEAD：`1dbe60c`
> 所有 `file:line` 均基于 HEAD 工作树核验，非 dist/.turbo 残留。
> 配套 spec：[`2026-06-27-observability-convergence.md`](../specs/2026-06-27-observability-convergence.md)（目标、产品动线、Phase 划分、PR 切分）。本文是它的「怎么一步步施工」展开，**把函数签名设计与测试改造提升为一等公民**。
> 上一轮 plan：[`2026-06-26-identifiers-and-di-convergence-plan.md`](./2026-06-26-identifiers-and-di-convergence-plan.md)（存储侧 id 收敛，本 plan 的前置；本 plan 沿用其夹具体系与三类 fake 分类法）。

---

## 0. 总纲：三条并行的改造线

和上一轮一样，这次收敛是**三条线交织**，不是「改生产代码、顺手修测试」：

```text
线 A  生产代码收敛   resume 修复 / checkpoint_events 加 spanId+词汇补齐 / Ops 读活事实流 /
                    删 event_log 死链 / checkpointer schema 正名 / 路由 runs→sessions
线 B  测试夹具建设   在已有 mock-deps.ts + packages/test-helpers 上扩（fakeSessionFactory 加 peek、
                    新增 http resume 夹具、checkpoint-events 读夹具）
线 C  测试断言迁移   appendEvent roundtrip 加 spanId 入参 / 删 event_log 测试 / 清 attemptId String 残留 /
                    onRunEvent 测试移除 / 前端路由 e2e
```

**铁律**：线 B 对应夹具先于线 A 的 Phase 落地。本轮夹具改动比上一轮小——上一轮已建好 `mock-deps.ts`（`testDB / makeRunDeps / mockSupervisor / TID` 等）与 `packages/test-helpers`（`echoModel`）。本轮主要是**在既有夹具上加 spanId 维度**、补一个 checkpoint_events 读夹具、补 http resume 注入夹具。

### 与 spec 的编号对应

| spec Phase | spec 编号 | 本 plan 章节 | PR |
|---|---|---|---|
| Phase 1 resume 修复 | P1 | §3 | PR-1 |
| Phase 2 checkpoint_events 加 spanId + 词汇补齐 | P3 | §4 | PR-2 |
| Phase 3 Ops 读 checkpoint_events + 清 attemptId | P2 + W-a | §5 | PR-3 |
| Phase 4 删 event_log 死链 | P6 | §6 | PR-4 |
| Phase 5 framework sessionId 正名 | P5 | §4.5（并入 PR-2） | PR-2 |
| Phase 6 路由 runs→sessions | R1 + W-b | §7 | PR-5 |

---

## 1. 现状盘点（线 A/B/C 的施工依据，全部 HEAD `1dbe60c` 核验）

### 1.1 活/死事实流的真实写读方（决定哪些能删、哪些要接）

| 流 | 表/接口 | 写方 | 读方 | 状态 |
|----|---------|------|------|------|
| 执行事实流（llm/tool） | `checkpoint_events`（**`checkpointer.db`**） | run-loop 15 处 `appendEvent?.(rt.thread.id, …)`（`execute-one.ts` 6 / `run-loop.ts` 7 / `create-agent.ts` 2） | **无**（Ops 还没接） | 活，但没人读 |
| 旧审计流 | `event_log`（**`events.db`**） | **无**（runner daemon 删除后零写入） | `service.ts:163/236`、`insights.ts:108/246/250` | 死表被读 → 详情/Insights 空白 |
| 控制面事件 | `run_ops_event`（`events.db`） | `supervisor.ts` appendRunEvent、`cron/scheduler.ts` | `service.ts`、`store.ts` | 活，保留 |

> 关键物理事实：`checkpoint_events` 在 **`checkpointer.db`**（`session-factory.ts:275` `sqliteCheckpointer({ db: join(config.dataDir, "checkpointer.db") })`），`event_log` / `run` / `attempt` / `run_ops_event` 在 **`events.db`**（`main.ts:69`）。Ops 现在只持有 `eventsDb`——P2 要让它**再开一个只读 `checkpointer.db` 连接**（读写分离，决策 b）。

### 1.2 resume 断链的确切病灶

| 事实 | 位置 |
|------|------|
| `resumeRoute()` 无依赖注入，import `getSession/removeSession` | `http.ts:3/10` |
| `getSession(runId)` 查空 map → 永远 404 | `http.ts:18-19` |
| resume 后 `if (state!=="waiting") { dispose(); removeSession() }`（per-run 时代逻辑） | `http.ts:24-27` |
| runId→sessionId 反查能力**已存在** | `store.ts:206` `getRuns(runIds)` 返回 `{ runId, sessionId, … }` |
| 活 session 在 SessionFactory，但**无 `peek`**（只有 getOrCreate/enqueuePrompt/dispose/disposeAll） | `session-factory.ts:41-57` |
| `assertSpecCompatible` / `SessionSpecMismatchError` 已落地 | `session-factory.ts:77/109` |

### 1.3 CheckpointEvent 词汇缺口（P3 补齐依据）

| 事件 | checkpoint_events 现写入 | run-loop 同时 yield 的 payload | 缺口 |
|------|--------------------------|-------------------------------|------|
| `model_end` | `{ blocks, usage, ts }`（`run-loop.ts:150-155`） | `llm_call { step, model, usage, latencyMs, ttftMs, stopReason }`（`:157-172`） | 缺 model/step/latencyMs/ttftMs/stopReason |
| `tool_end` | `{ result, durationMs, ts }`（`execute-one.ts:105-110`） | `tool_call { step, id, name, latencyMs, isError }`（`:111-120`） | 缺 step/name/isError |

> 字段**已在同一作用域算出来了**（就在 yield 旁边），补齐只是「把已有局部变量一并写进 appendEvent」，不是新增计算。

### 1.4 attemptId 残留（W-a 依据）

存储层 `attemptId` 已删，但 runtime-ops API 层 + 测试仍有 String 化死字段：

| 残留 | 位置 |
|------|------|
| `expect(events[0]!.attemptSeq).toBe("1")`（String，应为 number `1`） | `store.test.ts:40` |
| `expect(events[0]!.attemptId).toBeNull()`（字段应已不存在） | `store.test.ts:68` |
| service.ts 各处 `attemptId` 自赋值 + String 化 | spec §5.3 表（`service.ts:43/82/89/263/307/393/410`、`store.ts:18/68`、`types.ts:40`） |
| 前端 `attemptId` 类型 + `resumeRun` 返回 `{runId, attemptId}` | `api.ts:224/432/481/488/495`、`TraceWaterfall.tsx:93` |

### 1.5 onRunEvent 已是死回调（P6 删除安全性核实）

- `supervisor.#onRunEvent`（`:37`）只有注册方法 `onRunEvent()`（`:236-239`）入队，**全仓无 `notifyRunEvent` 触发点**（grep 确认：`supervisor.ts` 只有 `notifyRunMessage:244` / `notifyRunComplete:259`，无 `notifyRunEvent`）。
- 因此 `main.ts:178` 的 `supervisor.onRunEvent(...)` 回调**永不触发**——它已是死代码。其中的 `todo_update → accumulator`（`:180-187`）分支同样从不执行。
- **结论**：删除 onRunEvent 注册/字段/回调对运行时零行为影响。但 §6.1 列一个**前置核查步骤**：确认 todo_update 投影确实另有活路径（经 `onRunMessage`），否则它是一个**已存在的潜在 bug**（与本删除无关，但要记录在案，不能让删除动作背锅）。

### 1.6 schema 命名现状（P5 依据）

`checkpointer.db` 三表仍用 `threadId`：`checkpoint_messages.threadId`（`schema.ts:4`）、`checkpoint_interrupts.threadId`（`:10`）、`checkpoint_events.threadId`（`:19`）；sqlite 实现内部形参 `threadId`（`sqlite-checkpointer.ts:91/97/113`）。events.db 侧 `run.sessionId` 已正名（上一轮落地）。

---

## 2. 线 B 先行：夹具增量（PR-B0，并入各 PR 的首步）

本轮夹具改动小，不单独开 PR，而是**每个 Phase 的首个 commit 先改夹具**。集中列在此，便于核对。

### 2.1 三类 fake 分类法（沿用上一轮）

```text
A 记录型 / spy  —— 只为断言「被调用了什么」。例：recordingSupervisor.startedRuns
B 数据型 / stub —— 只为「喂合理返回值」。例：fakeGetSessionIdByRunId(map)
C 替身工厂      —— 造能「跑」的轻量真对象。例：fakeSessionFactory（echoModel 驱动）
```

### 2.2 新增/改动夹具签名（伪代码）

```ts
// apps/backend/test-helpers/mock-deps.ts （在现有导出上增量）

// ── P1：resume 注入夹具 ──────────────────────────────────────
// B 数据型：runId→sessionId 反查 stub
export function fakeGetSessionIdByRunId(map: Record<string, string>):
  (runId: string) => string | null;

// C 替身工厂：fakeSessionFactory 增 peek（与 P1 新增的接口方法对齐）
//   peek 命中返回 created.get(sid)，未命中返回 undefined（绝不新建）
export function fakeSessionFactory(opts?): SessionFactory & {
  created: Map<string, AgentSession>;
  promptCalls: Array<{ sessionId: string; input: string; runId?: string }>;
  peek(sessionId: string): AgentSession | undefined;   // ← 本轮新增
};

// ── P3/P2：checkpoint_events 读写夹具 ────────────────────────
// 复用 framework 的 inMemoryCheckpointer，但断言其 appendEvent 收到 (sessionId, spanId, event)
// C 替身：内存版 CheckpointEventsStore，喂结构化事实流给 Ops 测试
export function fakeCheckpointEventsStore(rows?: CheckpointEventRow[]): CheckpointEventsStore & {
  appended: CheckpointEventRow[];
};

// TID 增 span 维度（沿用上一轮 TID.session）
export const TID = {
  // …已有…
  span: (s = "sp1") => s,   // = 现 runId
};
```

> framework 侧 `packages/test-helpers` 的 `echoModel` 不动；`inMemoryCheckpointer` 的 `appendEvent`/`readEvents` 签名随 P3 改（见 §4.4），其测试同步。

---

## 3. Phase 1 — resume 人审闭环修复（PR-1，最高优先级，独立可发）

### 3.1 生产代码（伪代码）

**SessionFactory 新增只读 `peek`**（`session-factory.ts:41-57` 接口 + `:119` 实现）：

```ts
// 接口新增
export interface SessionFactory {
  // …已有 getOrCreate / enqueuePrompt / dispose / disposeAll…
  /** 取已存在的活 session；不存在返回 undefined（绝不新建）。 */
  peek(sessionId: string): AgentSession | undefined;
}
// createSessionFactory 内实现（sessions: Map<string, SessionEntry>）
function peek(sessionId: string): AgentSession | undefined {
  return sessions.get(sessionId)?.session;
}
```

**resumeRoute 改依赖注入**（`http.ts` 整体重写）：

```ts
// before: export function resumeRoute() { … getSession(runId) → 404 … }
// after:
export function resumeRoute(deps: {
  sessionFactory: SessionFactory;
  getSessionIdByRunId: (runId: string) => string | null;   // 见 §3.2
}) {
  return async (req: Request, runId: string): Promise<Response> => {
    const body = await parseJsonBody(req);
    if ("error" in body) return body.error;
    const parsed = resumeSchema.safeParse(body.data);
    if (!parsed.success) return json({ error: "Validation failed", details: parsed.error.issues }, 400);

    const sessionId = deps.getSessionIdByRunId(runId);
    if (!sessionId) return json({ error: "Run not found" }, 404);
    const session = deps.sessionFactory.peek(sessionId);
    if (!session) return json({ error: "Session no longer active — already settled" }, 409);

    try {
      await session.resume({ approved: parsed.data.approved, message: parsed.data.message });
      // ⛔ 删除 per-run 时代的 dispose/removeSession（:24-27）——
      //    session 跨 span 持久，生命周期归 SessionFactory 的 reaper / 显式 close，resume 不插手
      return json({ runId, resumed: true }, 202);
    } catch (err) {
      return json({ error: (err as Error).message }, 500);
    }
  };
}
```

### 3.2 反查能力复用现成 store

`getSessionIdByRunId` **不新写 SQL**——`RuntimeOpsStore.getRuns([runId])`（`store.ts:206`）已返回 `{ runId, sessionId }`。组装根包一层：

```ts
// main.ts 接线
const getSessionIdByRunId = (runId: string) =>
  opsStore.getRuns([runId])[0]?.sessionId ?? null;
const resume = resumeRoute({ sessionFactory, getSessionIdByRunId });
```

### 3.3 删 orphaned registry

- `session-registry.ts` 整文件删除。
- `main.ts` 中 `disposeSession` 的 import 与调用点删除（改由 `sessionFactory.dispose` / `disposeAll` 承担——后者已在 shutdown hook 接线）。
- `http.ts:3` 的 `import { getSession, removeSession } from "./session-registry.js"` 删除。

### 3.4 测试改造（线 B+C）

1. **新增 `http.test.ts`**（当前不存在）：注入 `fakeSessionFactory`（带 `peek`）+ `fakeGetSessionIdByRunId`，覆盖四态：
   - runId 反查不到 → 404；
   - 反查到但 `peek` 未命中（已 settle）→ 409；
   - `peek` 命中、resume(approved=true) → 202 且 `session.resume` 收到 `{approved:true}`；
   - resume(approved=false) → 202 且终止；二次 waiting → 可重复 resume。
2. `fakeSessionFactory` 加 `peek`（§2.2）。

> 验收：resume 不再恒 404；端到端「ToolApprovalCard 点批准 → run 续跑」闭合；`session-registry.ts` 全仓无引用。

---

## 4. Phase 2 — checkpoint_events 加 spanId + 词汇补齐 + schema 正名（PR-2，观测地基）

> 合并 spec 的 P3 + P5（§7 命名收尾），因两者同碰 `checkpointer.db` schema/migration，一次改完避免两次 migration。

### 4.1 schema 加 spanId + 列名正名（`schema.ts`）

```ts
// before（schema.ts:15-24）：checkpoint_events { id, threadId, event, ts }, idx(threadId, id)
// after：
export const checkpointEvents = sqliteTable("checkpoint_events", {
  id: integer().primaryKey({ autoIncrement: true }),
  sessionId: text().notNull(),          // threadId 正名（与 events.db run.sessionId 对齐）
  spanId: text(),                        // = 现 runId；nullable 兼容旧行
  event: text().notNull(),
  ts: integer({ mode: "number" }).notNull(),
}, (t) => [index("idx_checkpoint_events_span").on(t.sessionId, t.spanId, t.id)]);

// 同库正名（P5）：checkpoint_messages.threadId → sessionId（PK）、checkpoint_interrupts.threadId → sessionId（PK）
```

drizzle migration 一支：加 `span_id` 列 + 重命名 `thread_id`→`session_id`（三表）+ 重建索引。

### 4.2 CheckpointEvent 词汇补齐（`checkpointer.ts:20-43`）

```ts
// model_end 补 model/step/latencyMs/ttftMs/stopReason —— 与 run-loop yield 的 llm_call payload 对齐
| { type: "model_end"; blocks: ContentBlock[]; usage?: { input: number; output: number };
    model: string; step: number; latencyMs: number; ttftMs?: number; stopReason?: string; ts: number }
// tool_end 补 step/name/isError —— 与 tool_call payload 对齐
| { type: "tool_end"; result: ToolResultBlock; durationMs: number;
    step: number; name: string; isError: boolean; ts: number }
```

### 4.3 appendEvent/readEvents 签名加 spanId（`checkpointer.ts:57/61`）+ 去 @deprecated

```ts
// before:
//   appendEvent?(sessionId: string, event: CheckpointEvent): Promise<void>;
//   readEvents?(sessionId: string): AsyncIterable<CheckpointEvent>;
// after（去掉 @deprecated 注释，升为一等能力）:
appendEvent?(sessionId: string, spanId: string | undefined, event: CheckpointEvent): Promise<void>;
readEvents?(sessionId: string, opts?: { spanId?: string }):
  AsyncIterable<CheckpointEvent & { spanId: string | null; ts: number }>;
```

> `validateCheckpointer`（`checkpointer.ts:67`）的 append/read 成对校验逻辑不变（仍是「同时实现或同时省略」）。

### 4.4 三实现同步 + 15 处写入点透传 spanId

**写入点**（spanId 从 `rt.runId` 取——run-loop 已有，backend 经 `enqueuePrompt(…, {runId})` 透传进来）：

```ts
// run-loop.ts 7 处 / execute-one.ts 6 处 / create-agent.ts 2 处
// before: appendEvent?.(rt.thread.id, { … })
// after:  appendEvent?.(rt.thread.id, rt.runId, { … })
// create-agent.ts:178/244 用 thread.id，spanId 取 rt.runId（同作用域可达）

// 词汇补齐的两处把已有局部变量一并写进事件：
// run-loop.ts:150 model_end —— 补 model: rt.model.id, step, latencyMs: Date.now()-llmStart, ttftMs, stopReason
// execute-one.ts:105 tool_end —— 补 step, name: call.name, isError: resultBlock.is_error===true
```

**三实现签名同步**：
- `sqlite-checkpointer.ts:91/97`：`appendEvent(sessionId, spanId, event)` → insert `{ sessionId, spanId, event, ts }`；`readEvents(sessionId, opts?)` → `where(eq(sessionId)) [.and(eq(spanId))]`，select 增 `spanId, ts`。
- file-checkpointer / in-memory 同步签名。

### 4.5 测试改造（线 C）

1. `in-memory.test.ts:46-47` / `file-checkpointer.test.ts:66-67`：`appendEvent?.("t1", { … })` → `appendEvent?.("t1", TID.span(), { … })`；roundtrip 断言增 `spanId` 字段。
2. `create-agent.test.ts` 的 appendEvent 断言（spec §4 提及 :906/944）加 spanId 入参。
3. 新增「按 spanId 切片」用例：同 sessionId 写两个 spanId，`readEvents(sid, {spanId})` 只回该 span。
4. 词汇补齐 roundtrip：`model_end`/`tool_end` 读回带全字段。

> 验收：`checkpoint_events` 可按 `(sessionId, spanId)` 切片；`CheckpointEvent.model_end/tool_end` 带 Ops 全字段；append/read 去 @deprecated；schema 三表列名 `sessionId`。

---

## 5. Phase 3 — Ops 读 checkpoint_events + 清 attemptId 残留（PR-3，点亮观测面）

> 依赖 PR-2（事实流已可按 span 切且字段够用）。

### 5.1 新增只读 CheckpointEventsStore（`runtime-ops/checkpoint-events-store.ts`）

```ts
// 直连 checkpointer.db（只读），与 RuntimeOpsStore 直连 events.db 同构（读写分离，决策 b）
export interface CheckpointEventRow {
  sessionId: string; spanId: string | null; event: CheckpointEvent; ts: number;
}
export interface CheckpointEventsStore {
  readBySpan(sessionId: string, spanId: string): CheckpointEventRow[];     // span 排障详情
  readBySession(sessionId: string): CheckpointEventRow[];                   // session 详情聚合
  readWindow(from: number, to: number): CheckpointEventRow[];              // 监控汇总（替代 eventLog.read({limit}) 全表扫）
}
export function createCheckpointEventsStore(db: Database): CheckpointEventsStore;

// main.ts 接线：再开一个只读连接
const checkpointDb = new Database(`${config.dataDir}/checkpointer.db`, { readonly: true });
const checkpointEventsStore = createCheckpointEventsStore(checkpointDb);
```

### 5.2 三读点切换（service.ts / insights.ts）

```ts
// service.ts:163 listRuns 行最近事件类型
// before: db.query("SELECT json_extract(event,'$.type') as type, ts FROM event_log WHERE run_id=? ORDER BY seq DESC LIMIT 1")
// after:  const ev = checkpointEventsStore.readBySpan(sessionId, runId); const last = ev.at(-1);

// service.ts:236 getRunDetail 最近事件 —— 同上

// insights.ts:108/246/250 RunInsights
// before: await eventLog.read({ runId }) / eventLog.read({ limit:5000 })
// after:  checkpointEventsStore.readBySpan(sessionId, runId) / readWindow(from, to)
```

`insights.ts` 的判别器改认补齐后的事件：

```ts
// isLlmCall（insights.ts:75）等：从认 event_log 的 llm_call/tool_call 改为认 model_end/tool_end，
//   并映射出 { step, model, usage, latencyMs, ttftMs, stopReason } / { step, name, latencyMs, isError }
//   —— 字段已由 PR-2 补齐，直接读，无需重算
```

> service.ts:163/236 需要 sessionId：listRuns/getRunDetail 的 run 行本就带 `sessionId`（`run` 表列），传给 `readBySpan(sessionId, runId)` 即可。

> 控制面不混入：`run_ops_event`（attempt_started/reattach/cancel/retry）仍留 `events.db`，Ops 详情页把**控制面流**（run_ops_event）与**执行事实流**（checkpoint_events）按时间合并展示。

### 5.3 W-a：清 attemptId 残留（顺手做）

按 spec §5.3 表逐条删 `attemptId` 字段、`attemptSeq` 改 number：`service.ts:43/82/89/263/307/393/410`、`store.ts:18/68`、`types.ts:40`；前端 `api.ts:224/432/481/488/495`、`TraceWaterfall.tsx:93`（→ `attempt #${attemptSeq}`）。`resumeRun` 返回 `{runId, attemptId}` → `{runId, resumed}`（对齐 P1 后端 202 返回）。

### 5.4 测试改造（线 B+C）

1. **`store.test.ts:40`**：`expect(events[0]!.attemptSeq).toBe("1")` → `.toBe(1)`（number）。
2. **`store.test.ts:68`**：`expect(events[0]!.attemptId).toBeNull()` → 删该断言（字段不存在）。
3. `insights.test.ts`（当前用 `inMemoryEventLog().append()` 构造）：改用 `fakeCheckpointEventsStore(rows)` 喂结构化 `model_end`/`tool_end`，断言 Insights 重建出 llm_call/tool_call 指标。
4. CheckpointEventsStore 用 `:memory:` checkpointer.db + framework checkpointer 写入跑真 roundtrip（adapter 测试可碰真 sqlite）。
5. 前端类型编译通过（attemptId 删除后无残引用）。

> 验收：run/session 详情、TraceWaterfall、RunInsights 显示真实 llm_call/tool_call；不再 `SELECT FROM event_log`；runtime-ops 无 attemptId 字段、attemptSeq 为 number。

---

## 6. Phase 4 — 删 event_log 死链（PR-4，收口）

> 依赖 PR-3（读方切完才能删）。

### 6.1 删除前置核查（唯一需二次确认点）

```text
核查 1：grep 全仓 event_log / EventLog / .append( —— 确认 PR-3 后无活读写方（除 tombstone 文档）。
核查 2：todo_update 投影路径。main.ts:178 onRunEvent 回调已是死代码（§1.5），
        但删除前确认 todo_update 经 onRunMessage（notifyRunMessage:244 是活的）流到 projection，
        而非仅靠这条死回调。若发现 todo 投影实际依赖此死回调 → 那是一个已存在 bug，
        需另开修复项，不在本 PR 删除范围内静默吞掉。
```

### 6.2 删除清单

- `apps/backend/src/features/event-log/` 整目录删（`EventLog`/`EventSink`/`EventSource`/`sqliteEventLog`/`inMemoryEventLog`/`EventRecord`）。
- `events-schema.ts` `event_log` 表定义删 + drizzle migration `DROP TABLE event_log`。
- `main.ts:74` `const eventLog = sqliteEventLog(...)` + 其 import 删；`main.ts:178-191` `supervisor.onRunEvent(...)` 回调删。
- `supervisor.ts:37`（`#onRunEvent` 字段）+ `:236-239`（`onRunEvent()` 注册方法）删。
- `RuntimeOpsService` 的 `eventLog: EventLog` 依赖删，换 `checkpointEventsStore`（PR-3 已注入）。
- `agent-svc-factory.ts:46` 删 agent 时 purge `event_log` 的 raw SQL（`edb.run("DELETE FROM event_log WHERE session_id = ?")`）：去掉 `event_log` 那段（表已不存在），保留 attempt/run 的 purge；同步改 `:40` 的 M20 注释。

### 6.3 测试改造

1. `event-log/index.test.ts` 删。
2. `insights.test.ts` 去掉 `inMemoryEventLog` import（PR-3 已改用 fakeCheckpointEventsStore，此处确认无残引用）。
3. `supervisor.test.ts` 去掉 onRunEvent 相关断言。
4. 全仓 `grep -n 'event_log\|EventLog\|onRunEvent'` 归零（除 tombstone 文档）。

> 验收：event_log 表 / EventLog / sqliteEventLog / inMemoryEventLog / supervisor.onRunEvent 全删（含 migration DROP TABLE）。

---

## 7. Phase 6 — 路由收敛 runs → sessions（PR-5）

> 依赖 PR-3（详情页要有数据才有意义）。

### 7.1 路由调整

```text
app/(main)/ops/runs/            → rename app/(main)/ops/sessions/         （列表 query 改 groupBy sessionId）
app/(main)/ops/runs/[runId]/    → app/(main)/ops/sessions/[sessionId]/    （聚合 span 列表 + span 瀑布）
app/(main)/ops/traces/*         → 删除                                    （session 即 trace）
```

### 7.2 数据获取（动线 A 支撑）

```ts
// /ops/sessions 列表：按 sessionId 聚合 run 行（每个 sessionId 一行：状态/最近 span 时间/累计 span 数/成本）
//   后端可在 RunQueryService 加 listSessions()，或前端对 listRuns 结果 groupBy sessionId
// /ops/sessions/[sessionId]：
//   头部 = session 当前状态（peek 或最近 run 终态）+ 归属 agent + 上下文
//   span 列表 = 该 sessionId 下的 run 行（现 runId = spanId）
//   span 瀑布 = TraceWaterfall 复用，喂 checkpointEventsStore.readBySpan(sessionId, spanId)
```

### 7.3 前端链接改点（spec §8.2 表）

| 文件 | before | after |
|------|--------|-------|
| `HealthSummary.tsx:59/61/67` | `/ops/runs?…` | `/ops/sessions?…` |
| `RunOpsTable.tsx:133` | `/ops/runs/${r.runId}` | `/ops/sessions/${r.sessionId}` |
| `RunDiagnosisHeader.tsx:63` | `/ops/traces/${traceId}` | 删该链接 |
| `TraceWaterfall.tsx:80/114` | `/ops/runs/${e.runId}` | span 锚点（同 session 内跳转） |
| `IssueDetailSheet.tsx:88` | `/ops/runs/${run.runId}` | `/ops/sessions/${sessionId}#span-${runId}` |

> `W-b`（前端 runId→spanId **字段名**物理改名）不在本轮——本 Phase 只做路由与 URL 语义层（runs→sessions），DOM 变量名/API 字段名跟随后续 `run→span` 里程碑（spec §9 延后项）。

### 7.4 测试改造

- 所有 `/ops/runs`、`/ops/traces` 的 Next.js 路由链接 e2e 改 `/ops/sessions`。
- 面包屑（`ops/sessions/[sessionId]/page.tsx` Breadcrumb）。
- e2e 导航：sessions → session 详情 → span 瀑布 不空白。

> 验收：`/ops/sessions` 列 session、`/ops/sessions/[sessionId]` 聚合 span 列表 + 瀑布；`/ops/runs`、`/ops/traces` 不可达。

---

## 8. 施工顺序与依赖

```text
PR-1  Phase 1  resume 修复 + SessionFactory.peek + 删 session-registry        ← 最高优先级，独立可发
PR-2  Phase 2  checkpoint_events 加 spanId + 词汇补齐 + schema 正名（P3+P5）   ← 观测地基
PR-3  Phase 3  Ops 读 checkpoint_events（P2）+ 清 attemptId（W-a）             ← 依赖 PR-2
PR-4  Phase 4  删 event_log/EventLog/onRunEvent 死链（P6）                      ← 依赖 PR-3
PR-5  Phase 6  路由 runs→sessions + 删 /ops/traces（R1/W-b 部分）              ← 依赖 PR-3
```

**强链**：PR-2 → PR-3 →（PR-4 / PR-5 并行）。PR-1 与其余解耦，最先且独立上线（用户可感知的功能 bug）。

---

## 9. 测试改造的横切原则（贯穿所有 PR）

1. **不再内联手写 fake**：resume/checkpoint-events 替身一律从 `mock-deps.ts` import；第三处用到就提进夹具。
2. **spanId 不写裸字符串**：测试 spanId 经 `TID.span()` 生成。
3. **能注入就不连真依赖**：Ops 读测试用 `fakeCheckpointEventsStore`；只有 checkpointer adapter / migration 测试碰真 sqlite。
4. **窄 fake**：`fakeGetSessionIdByRunId` 只实现一个函数签名；`fakeSessionFactory` 只补 `peek`。
5. **每个 Phase 自带测试迁移**：改接口的同 PR 改完对应测试（§1.4 attemptId 残留、§4.5 spanId 入参、§6.3 onRunEvent 移除逐条点名）。
6. **删除类 PR 配 grep 归零断言**：PR-4 落地以 `grep event_log|EventLog|onRunEvent` 归零（除 tombstone）为验收硬指标。

---

## 10. 验收总清单

生产代码（同 spec §10）：
- [ ] resume 不再 404：runId→DB 反查 sessionId → SessionFactory.peek → resume；approved=true 续跑 / false 终止 / 二次 waiting 可重复。
- [ ] `checkpoint_events` 有 `spanId` 列，可按 `(sessionId, spanId)` 切片；`model_end`/`tool_end` 带全字段（model/latencyMs/ttftMs/step/name/isError）。
- [ ] Ops 经只读 store 直连 `checkpointer.db` 读事实流；run/session 详情、TraceWaterfall、RunInsights 不再空白。
- [ ] `event_log`/`EventLog`/`sqliteEventLog`/`inMemoryEventLog`/`supervisor.onRunEvent` 全删（含 migration DROP TABLE）。
- [ ] `appendEvent`/`readEvents` 去 @deprecated；checkpointer 三表列名 `sessionId`。
- [ ] runtime-ops 无 `attemptId` 残留，`attemptSeq` 为 number。
- [ ] `/ops/sessions` 列 session、`/ops/sessions/[sessionId]` 聚合 span 列表 + 瀑布；`/ops/runs`、`/ops/traces` 不可达；`session-registry.ts` 删除。

测试（本 plan 新增/改动）：
- [ ] 新增 `http.test.ts`：resume 四态（404/409/approved/rejected + 二次 waiting）注入 fakeSessionFactory(peek) + fakeGetSessionIdByRunId。
- [ ] `in-memory.test.ts` / `file-checkpointer.test.ts` / `create-agent.test.ts` 的 appendEvent 加 spanId 入参；按 spanId 切片用例；词汇补齐 roundtrip。
- [ ] `store.test.ts:40` String→number；`:68` attemptId 断言删；`insights.test.ts` 改用 fakeCheckpointEventsStore。
- [ ] `event-log/index.test.ts` 删；`supervisor.test.ts` 去 onRunEvent；全仓 grep `event_log|EventLog|onRunEvent` 归零。
- [ ] 前端 e2e：sessions → session 详情 → span 瀑布导航不空白；`/ops/runs`、`/ops/traces` 链接清零。

---

## 11. 关联

- 配套 spec [`2026-06-27-observability-convergence.md`](../specs/2026-06-27-observability-convergence.md)
- 上一轮 plan [`2026-06-26-identifiers-and-di-convergence-plan.md`](./2026-06-26-identifiers-and-di-convergence-plan.md) —— 夹具体系与三类 fake 分类法的来源
- 架构页 [`foundations/identifiers.md`](../../architecture/foundations/identifiers.md) —— session=trace / span=prompt loop 的 id 目标模型
- 架构页 [`backend/event-log.md`](../../architecture/backend/event-log.md) —— EventLog tombstone（死表由来）
- 架构页 [`foundations/facts-and-projections.md`](../../architecture/foundations/facts-and-projections.md) —— 执行事实流归属 checkpointer 的边界
