# 标识符收敛 + 依赖注入修复 

> 状态：实施 spec（含逐项 before/after、文件行号、回归点、分阶段 PR）
> 基准 HEAD：`05d6ed72`（分支 `feature/agent-session-integration`，`e5a4b390` 是其祖先）
> 所有 `file:line` 均基于 `git show 05d6ed72:` / `git grep 05d6ed72` 跟踪文件核验，非 dist/.turbo 工作树残留。
> 上游依据：架构页 [`foundations/identifiers.md`](../../architecture/foundations/identifiers.md)（id 目标模型）+ [`foundations/dependency-injection.md`](../../architecture/foundations/dependency-injection.md)（DI 主轴与判断准则）。本 spec 把两者合并成一套可施工的收敛计划。
>
> **本版相对 e5a4b390 版的差异（已落地、不再重复开方）：**
> - `DI#3` 协议泄漏 **已修**：`onRunStatus` 回调 + `emitRunStatus`（`run-executor.ts:57-65 / :225-239`）已替换 `buildRunStatusRevision` hack，执行层不再绑死 message 线协议。本 spec 不再含该项。
> - 共享测试夹具 **已部分落地**：`apps/backend/test-helpers/mock-deps.ts` 已存在并导出 `testDB / mockConfig / mockOpsStore / mockAgentSvc / mockSupervisor / testIdGen / testDir`。后续在其之上扩，而非从零重建。
> - `buildPromptVars` **已是 `createOrchestrator` 内嵌函数**（`reactor.ts:72`），DI#8 拆分只剩 stepRunner / reactor 外提。
> - `executeAgentRun` 入参袋已增长到 **18 字段**（`run-executor.ts:37-65`，含新 `onRunStatus`）。
> - ID 格式纠正：production 实为**两种** shape（`:owner` 与 `:${agentId}`），非旧版记的三种；`reactor.test.ts:250` 的 `:planner` 只是测试里 agentId=planner，属 `:${agentId}` 形态。

---

## 0. 为什么合并：两个问题同源，枢纽是 `executeAgentRun`

ID 体系的错位和 DI 的中高问题不是两件事，而是同一处代码的两个侧面。`executeAgentRun`（`run-executor.ts:77`）这一个 fire-and-forget 函数同时是：

- **DI 最集中的反例**：收 18 字段大袋子（`:37-65`），函数体内 `agentSvc.getById(agentId)`（`:120`）现查 agent、`new AnthropicChatModel`（`:124`）、`sqliteCheckpointer`（`:175`）、`pipeContextManagers`（`:179`）、`new AgentSession`（`:185`）现造 session，把本该留在 `main.ts` 的 `new` 漏到执行层。
- **ID 错位的发生处**：每个 run `new AgentSession`（`:185`）+ run 完 `session.dispose() + removeSession(runId)`（`finalizeOnce`，`:204-206`，仅 `state !== "waiting"` 时）→ session 是 per-run 临时对象；`session.prompt(input, { signal })`（`:249`）**不传 runId** → framework 回退 `rt.runId = opts.runId ?? thread.id`，多个 run 落同一条线（同一 sessionId）时共用一个 runId，`assistantMessageId(runId, ordinal)` 串号。

所以单独修 DI 会动这个函数，单独做 ID 收敛也要动这个函数——分两次改是浪费且互相冲突。本 spec 一次性把它改对：**接收已造好的能力（注入 `SessionFactory`）+ 按 sessionId 复用持久 session + runId 显式流入 harness**。其余 DI 中问题（supervisor / ops service / cron / setup / orchestrator 拆分）作为同批次的独立小 PR 收尾。

### 编号体系

- `ID#n`：标识符收敛项（来自 identifiers.md）。
- `DI#n`：依赖注入修复项（来自 dependency-injection.md）。
- `Phase n`：施工阶段，按依赖顺序排，每个 Phase = 一个可独立 review 的 PR。

---

## 1. 收敛目标（一句话锚点）

```text
实体主键（conversationId/agentId/memberId/issueId/cronJobId）：独立、不派生、ulid。
运行上下文 id：sessionId → runId → attemptSeq，一条派生链。
  · sessionId（= 现 threadId 正名）：持久记忆线本体，AgentSession 跨 run 复用，checkpointer 唯一 key。
  · runId：session 上的一次 prompt loop，backend 生成，必须显式流入 harness。
  · attemptSeq：run 内重试序号，(runId, seq) 复合键，不配独立 id。

依赖方向：core 定窄接口 → adapter 外层实现 → harness 只认接口 → main.ts 顶层组装。
  · 业务函数只接收造好的能力，不在函数体 new 具体实现。
  · 依赖接口要窄：声明 = 实际用到。
```

---

## 2. 现状盘点：四种 sessionId 派生公式（ID#5 的施工依据，全部 05d6ed72 核验）

| 触发源 | 派生点 | 当前公式 | 形态 |
|--------|--------|----------|------|
| 会话 | `conversation/service.ts:24` `deriveThreadId` | `${conversationId}:${memberId}` | `上下文:agent成员` |
| Issue 创建 | `issue/service.ts:72` | `${issueId}:owner` | `上下文:字面 owner` |
| 编排派活 | `orchestrator/reactor.ts:122` | `${issueId}:${t.agentId}` | `上下文:agent` |
| Cron 触发 | `cron/scheduler.ts:36` | `${cronJobId}:owner` | `上下文:字面 owner` |

两种 shape：**`:${agentId}`**（会话、编排）与 **`:owner`** 字面量（issue 创建、cron）。目标是把 `:owner` 字面量收敛进 `:${agentId}`，让派生公式只有「上下文 : agent」一个心智。`:owner` 场景用一个保留 agentId（如 issue/cron 的默认 owner agent）替代。

> 纠正：旧版 spec 记的「三种格式（`:owner` / `:${agentId}` / `:planner`）」不准确。`reactor.test.ts:250` 断言 `${planned.issueId}:planner` 是因为该测试的 column config 把转移的 `agentId` 设成 `"planner"`——它就是 `:${agentId}` 形态，agentId 恰为 planner，不是第三种生产格式。

---

## 3. Phase 0 — 类型与接口地基（解锁后续全部）

这一阶段不改行为，只立类型和抽象，让后面几个 Phase 有依附点。

### 3.1 `ID#1` threadId → sessionId 正名

**范围**：harness `AgentSessionConfig.threadId`（`agent-session.ts:35`）、framework `create-agent.ts` 的 `config.threadId`、checkpointer 接口入参名（`checkpointer.ts:46-63` 七个方法均用 `threadId`）、backend 四条派生公式的变量名与 `deriveThreadId`（`conversation/service.ts:23`）。

**做法**：纯重命名 + 兼容别名过渡，分两步避免一次性大爆炸：

1. 在 `AgentSessionConfig`（`agent-session.ts:32`）和 `CreateAgentConfig`（`create-agent.ts` 附近）**新增 `sessionId?: string`，保留 `threadId?: string` 为 `@deprecated` 别名**，内部 `const sessionId = config.sessionId ?? config.threadId`。
2. checkpointer 接口（`checkpointer.ts:45`）七个方法（`load/save/saveInterrupt/consumeInterrupt/appendEvent/readEvents/deleteThread`）入参从 `threadId` 改名 `sessionId`——**纯参数名**，类型签名不变（仍是 `string`），sqlite 实现的列名 `thread_id`（`events-schema.ts` event_log）暂不动（迁移成本高、收益低，留作独立技术债项 `ID#1b`）。

> 关键约束：本步只改「面向调用方的命名」，不改存储 schema。存储层列名保留，注释标明「逻辑上即 sessionId」。

**回归点**：harness / framework 单测里所有 `threadId:` 入参；backend `deriveThreadId` 调用点（`conversation/service.ts:145`）；`parseThreadId`（`:30`）。

### 3.2 `DI#1-prep` + `ID#2` 引入 `SessionFactory` 抽象

这是整个 spec 的核心新抽象，同时解决「executeAgentRun 在函数体造 session」（DI）和「session 该按 sessionId 复用」（ID）。

**新增**（落 `apps/backend/src/features/run/session-factory.ts`）：

```ts
// 窄接口：调用方只声明「给我一个能跑的 session」，不关心怎么造
export interface SessionFactory {
  /** 按 sessionId 取已存在的持久 session，没有则按 spec 造一个并登记。 */
  getOrCreate(sessionId: string, spec: SessionSpec): AgentSession;
  /** 显式回收（会话归档 / agent 下线 / issue 关闭）。 */
  dispose(sessionId: string): void;
}

export interface SessionSpec {
  agentId: string;
  cwd: string;
  model: ChatModel;            // 已造好，不在 factory 里 new
  plugins: Plugin[];
  tools: Tool[];
  checkpointer: Checkpointer;  // 已造好
  contextManager: ContextManager;
}
```

**`createSessionFactory(deps)`** 在 `main.ts` 组装根创建一次，内部持有按 sessionId 索引的 registry（替代现 `session-registry.ts` 的 runId-key map：`registerSession(runId,…)` / `removeSession(runId)` / `disposeSession(runId)`）。`new AnthropicChatModel` / `sqliteCheckpointer` 等具体实现的 `new` 全部上移到 `main.ts`，由组装根注入到 factory 的 `materialize` 回调里（参照 `createAgentSvc` 的 `materializeWorkspace` 函数注入手法）。

**回归点**：无（纯新增），但要确保 `main.ts` 能拿到造 model / checkpointer 所需的 config（现 `main.ts:69` 已有 `eventsDb`）。

### 3.3 `ID#3` attempt 类型从 id 改 seq（仅类型，不改存储）

先把类型和返回签名改好，存储迁移留到 Phase 3。

- `executeAgentRun` 返回 `{ runId, attemptId }`（`run-executor.ts:79`）、`supervisor.startMainRun` 返回 `{ runId, attemptId }`（`supervisor.ts:176`）等处，**新增 `attemptSeq: number`**，`attemptId` 暂保留为 `@deprecated`（值仍 `att-${runId}`，`supervisor.ts:178`），过渡期两者并存。

---

## 4. Phase 1 — 重构 `executeAgentRun`（枢纽，解决 DI#1 + ID#2 + ID#4）

这是收益最大的一个 PR。改完后 executeAgentRun 从「18 字段袋子 + 函数体造 4 个对象」变成「接收造好的 session + 透传 runId」。

### 4.1 `DI#1` 注入粒度：收 session，不收原料；入参按三触发源拆窄

**Before**（`run-executor.ts:117-185`，节选）：

```ts
const { attemptId } = await supervisor.startMainRun(runId, threadId, { agentId, threadId }); // :117
const agent = await agentSvc.getById(agentId);          // :120 现查 agent
mkdirSync(cwd, { recursive: true });                    // :122
const model = new AnthropicChatModel({ ... });          // :124 现造 model
const checkpointer = sqliteCheckpointer({ ... });       // :175 现造 checkpointer
const contextManager = pipeContextManagers(...);        // :179
const session = new AgentSession({ model, threadId, ... }); // :185 现造 session
```

**After**：

```ts
// model / checkpointer / contextManager / plugins / tools 的组装上移到 main.ts，
// 经 SessionFactory 注入。executeAgentRun 只声明它要一个能跑的 session。
const session = deps.sessionFactory.getOrCreate(req.sessionId, spec);
const { runId, attemptSeq } = await deps.supervisor.startMainRun(runId, req.sessionId, { agentId });
```

`ExecuteAgentRunOpts` 18 字段袋子（`:37-65`）按 [`foundations/identifiers.md`](../../architecture/foundations/identifiers.md) 的「会话 / cron / 编排」三触发源拆成 **稳定能力 `RunDeps`** + **每次调用数据 `RunRequest`** + **触发源判别联合 `RunOrigin`**（详见配套 plan §4 的伪代码）。

### 4.2 `ID#4` runId 显式流入 harness

**Before**：`void session.prompt(input, { signal }).catch(...)`（`:249`）——不带 runId，framework 回退 `thread.id`。

**After**：

```ts
void session.prompt(input, { signal, runId }).catch(...);
```

连带 harness 改动：`AgentSession.prompt(text, opts?)`（`agent-session.ts:170`，现签名 `opts?: { signal?: AbortSignal }`）的 `opts` 增加 `runId?: string`，在调用 `this.#agent.run(..., { signal, maxSteps, runId })` 时透传；framework `run-loop.ts` 的 `rt.runId = opts.runId ?? thread.id` 回退保留作兜底，但正常路径下 backend 总会传。这样 `assistantMessageId(runId, ordinal)` 在一条 session 服务多个 run 时不再串号。

**回归点**：`run-loop.ts` 里所有读 `rt.runId` 的点；`assistantMessageId` 的产出格式测试；executeAgentRun 内 `onAssistantMessage` 解析 ordinal 的逻辑——ordinal 按 run 重置（配合 runId 切片），需在 plan 里定死。

### 4.3 `DI#3` 协议泄漏 —— ✅ 已修，无需开方

`onRunStatus`（`:57-65`）+ `emitRunStatus`（`:225-239`，对 `compaction_start/end`、`auto_retry_start/end`、`agent_end` 发独立 `run_status` 语义帧）已在 05d6ed72 落地，替换了旧的 `buildRunStatusRevision`（已删除）。执行层不再 import message 线协议。**本项仅作记录，不在施工范围。**

---

## 5. Phase 2 — AgentSession 跨 run 持久 + 回收策略（`ID#2` 完成）

Phase 1 已把 session 改成经 factory 按 sessionId 取。本阶段补「持久」语义和「谁销毁」。

### 5.1 生命周期反转

**Before**（`run-executor.ts:204-206`）：`finalizeOnce` 里 `if (session.state !== "waiting") { session.dispose(); removeSession(runId); }`——run 完即销毁。

**After**：`finalizeOnce` 只标记 run 终态（`onComplete` / `supervisor.markRunComplete`），**不销毁 session**。session 留在 factory 的 sessionId-registry 里，等待同一条线的下一个 run 复用。

### 5.2 回收策略（跨 run 持久唯一新增成本，必须定清）

spec 建议落 **idle timeout + 显式 close 双保险**：

1. **idle timeout**：factory 内每个 session 记 `lastUsedAt`，后台 reaper（复用 supervisor 已有的 `reaperTimer` / `reaperIntervalMs` 定时器思路，`supervisor.ts:45/:73-76`）定期 dispose 超过 N 分钟未用的 session。
2. **显式 close**：会话归档 / agent 下线 / issue 关闭时，调用 `sessionFactory.dispose(sessionId)`。
3. **进程退出**：`main.ts` 注册 shutdown hook，dispose 全部。

**关键约束**：`session.state === "waiting"`（等待审批 / 人工 gate，`agent-session.ts:218`）的 session **绝不能被 idle reaper 回收**——现 `finalizeOnce` 已有 `if (session.state !== "waiting")` 判断（`run-executor.ts:204`），回收策略要继承这条。

**回归点**：内存泄漏验证（长跑多 session 场景）；waiting 态 session 不被误回收的测试。

---

## 6. Phase 3 — attempt → seq（`ID#3` 存储落地）

### 6.1 存储

`attempt` 表（`events-schema.ts:29-35`）当前 PK 是 `attemptId: text().primaryKey()`（`:32`），含 `.references(() => run.runId, { onDelete: "cascade" })`（`:35`）。改为复合：

```ts
// before: attemptId: text().primaryKey(), runId: text().notNull().references(...)
// after:
runId: text().notNull().references(() => run.runId, { onDelete: "cascade" }),
seq: integer().notNull(),
// primaryKey([runId, seq])，去掉 attemptId 列
```

`run_ops_event.attemptId`（`events-schema.ts:50` nullable `text()`，**非外键**——`git grep` 确认无 `.references()`）改存 `attemptSeq integer`（或保留列但语义改为 seq 展示）。因为它不是 FK，迁移无引用完整性风险。

### 6.2 写入与读取

- `supervisor.ts:178` 的 `const attemptId = \`att-${runId}\`` + `INSERT INTO attempt (attempt_id, run_id, started_at)`（`:186`）改为 `seq`：首次 `seq=1`，重试 `MAX(seq)+1`。
- reattach / 诊断查询：`runtime-ops/service.ts:154`（`SELECT attempt_id … ORDER BY started_at DESC LIMIT 1`）、`:235`（`ORDER BY started_at DESC`）改 `ORDER BY seq DESC`，语义更直白。
- `#finalizeRun` / `#markProjectionDegraded`（`supervisor.ts:136/154`）的 `attemptId: string | null` 参数改 `attemptSeq: number | null`；`reaper` 调用点（`:113/:126`）的 `row.attempt_id` 同步。

### 6.3 展示层

- ops 详情页 `attemptId.slice(...)` → 显示 `#${seq}`。
- `TraceWaterfall` 的 `attemptId:` → `attempt #${seq}`。
- `api.ts` 几处 `attemptId: string` 类型同步（`runtime-ops/service.ts:42/79/86/273/312/396/412` 都返回 `attemptId`，需统一）。

**回归点**：`supervisor.test.ts:10` 断言 `expect(attemptId).toBe("att-r1")` → `expect(attemptSeq).toBe(1)`；`reactor.test.ts:96` 的 fake 返回 `{ runId, attemptId: \`attempt-${runId}\` }` → 加 `attemptSeq`；ops store / service 相关测试。

---

## 7. Phase 4 — 周边 DI 中高问题（独立小 PR，可并行）

这些不在枢纽上，但属同批次债务，各自一个小 PR。

### 7.1 `DI#2` RunSupervisor 拆分（SRP/DIP，高）

`supervisor.ts:32` 一个类管：生命周期 + events.db 迁移与直接 SQL（`:186` 裸 `INSERT`）+ reaper 定时器（`:45/:76`）+ 监听器；构造默认 `this.#db = opts.db ?? new Database(\`${opts.config.dataDir}/events.db\`)`（`:50`）。

**做法**：
- DIP：`Database` 改强制注入（构造收 `db: Database`，去掉 `?? new Database`），`new` 上移 `main.ts`（`main.ts:69` 已有 `eventsDb`，直接传）。
- SRP：把「reaper 定时器」「监听器分发」拆成协作者；events.db 的直接 SQL 收进一个 `RunStore`（参照 ops 的 store/service 分层）。
- `DI#2b` `RunSupervisorOptions`（`supervisor.ts:11-12`）里 `eventLog: EventLog` 字段重构后**从不 `.append()`**（`git grep 05d6ed72` 仅命中 `:12` 类型声明，全文件无其它使用）→ **删除该依赖**（声明了不用是误导）。

### 7.2 `DI#4` RuntimeOpsService 拆分（SRP，高）

`runtime-ops/service.ts:90` `createRuntimeOpsService` 起 12 方法上帝对象，运行管理 / 监控 / 诊断 / 报表四类挤一处；`listRuns`（`:104`）内 `sql +=` if 链拼 SQL（`:137` 等，OCP）。

**做法**：按四类关注点拆成 4 个窄 service；`listRuns` 的过滤条件改「filter spec → 查询构造器」消除 if 链。

### 7.3 `DI#5` getSetupManager（DIP，中）

`main.ts:203` 函数体 `new CliSetupProvisioner()`（`:205`）焊死具体 provisioner。**做法**：provisioner 改参数注入。

### 7.4 `DI#6` createCronScheduler（DIP，中）

`cron/scheduler.ts:164` 直接 `Bun.cron(...)`，无法注入假调度器测时间逻辑。**做法**：抽 `Scheduler` 窄接口（`register(cron, fn)`），`Bun.cron` 实现在外层，测试注入假调度器。

### 7.5 `DI#7` startAgentRun 透传 wrapper（SRP/DRY，低）

`conv-svc-factory.ts:153` `startAgentRun` 纯透传，逐行手抄字段进 `executeAgentRun`（`:156`）。Phase 1 把 executeAgentRun 入参收窄（`RunDeps`/`RunRequest`/`RunOrigin`）后，这个 wrapper 大概率可直接删除或退化成一行。

### 7.6 `DI#8` createOrchestrator 拆分（SRP，中）

`reactor.ts:55` `createOrchestrator(deps)` 闭包里同时握 `buildPromptVars`（`:72` 纯函数，已内嵌）、`startStep`（`:101` 派活、derive threadId、调 executeAgentRun）、`onRunComplete`（`:161` 终态门控、幂等、applyTransition、递归 startStep）。三件事职责不同。

**做法**：把 `buildPromptVars` 提为模块级纯函数（零依赖）；`startStep` 收进 `createStepRunner(StepRunnerDeps)`；`onRunComplete` 收进 `createTransitionReactor(TransitionReactorDeps & { stepRunner })`；`createOrchestrator` 退化成薄壳，仅 wire 两者并保持 `main.ts` 接线不变（仍返回 `{ startStep, onRunComplete }`）。用 `Pick<>` 把各自依赖收窄（详见 plan §7 伪代码）。

---

## 8. Phase 5 — sessionId 格式统一（`ID#5`）

把 `:owner`（`issue/service.ts:72`、`cron/scheduler.ts:36`）统一为 `${上下文}:${agentId}` 形态。`:owner` 场景用对应保留 agentId（issue 的默认 owner agent / cron 的 job owner agent）替代，让派生公式只有「上下文 : agent」一个心智。

**回归点**：`issue/service.test.ts:38/46` 断言 `toBe("test-iss-0:owner")` / `toBe(\`${issue.issueId}:owner\`)` 需改；`reactor.test.ts:250` 断言 `${planned.issueId}:planner`（其实已是 `:${agentId}` 形态，无需改公式，只确认统一后仍成立）；projection 按前缀匹配的逻辑（`conv-svc-factory.ts:126` 的 `row.thread_id.startsWith(\`${conversationId}:\`)`、`parseThreadId` `conversation/service.ts:30`）核对。

---

## 9. 施工顺序与 PR 切分

```text
PR-B0 共享夹具补强（在已有 mock-deps.ts 上扩 fakeSessionFactory/TID/记录型 supervisor）  ← 最先
PR-0  Phase 0  类型/接口地基（sessionId 别名 + SessionFactory 接口 + attemptSeq 类型）   ← 阻塞全部
PR-1  Phase 1  executeAgentRun 重构（DI#1 + ID#4；DI#3 已修不含）                        ← 最大收益
PR-2  Phase 2  AgentSession 跨 run 持久 + 回收策略（ID#2）                                ← 依赖 PR-1
PR-3  Phase 3  attempt → seq 存储迁移（ID#3）                                            ← 可与 PR-2 并行
PR-4  Phase 5  sessionId 格式统一（ID#5）                                               ← 独立
PR-5  Phase 4  周边 DI 中高问题（DI#2/4/5/6/7/8）                                        ← 独立，可并行
PR-6  收尾     sessionId 列名迁移 ID#1b（thread_id → session_id，可选，低优先）
```

**强依赖**：PR-B0 → PR-0 → PR-1 → PR-2。其余可并行。
**测试债提醒**：每个 PR 落地时，对应 `*.test.ts` 的断言（上文「回归点」已逐项点名）必须同步改，不能靠「测试通过」误判——多处测试直接硬编码了 `att-r1`、`:owner`、`c:test`/`i:a`/`cr:o` 这类即将变更的字符串。

---

## 10. 验收标准

- [ ] checkpointer / harness / framework 面向调用方的 id 入参统一叫 `sessionId`（列名迁移可延后）。
- [ ] executeAgentRun 函数体内无 `new AnthropicChatModel` / `sqliteCheckpointer` / `new AgentSession` / `mkdirSync`；改为 `sessionFactory.getOrCreate`。
- [ ] executeAgentRun 入参从 18 字段袋拆成 `RunDeps` + `RunRequest` + `RunOrigin`。
- [ ] 同一 sessionId 的连续两个 run 复用同一个 AgentSession 实例（registry 命中），run 完不 dispose。
- [ ] idle / 显式 close / 进程退出三条回收路径有其一落地，且 waiting 态 session 不被 idle 回收（有测试）。
- [ ] `session.prompt` 收到并透传 runId；多 run 同 session 时 assistantMessageId 不串号。
- [ ] attempt 无独立 id，`(runId, seq)` 复合键；ops 展示 `#seq`。
- [ ] sessionId 只有 `${上下文}:${agentId}` 一种 shape（`:owner` 字面量消除）。
- [ ] DI 中高项（supervisor 拆分 + ops service 拆分 + cron/setup 可注入 + orchestrator 拆分）各自 PR 落地。

---

## 11. 关联

- 架构页 [`foundations/identifiers.md`](../../architecture/foundations/identifiers.md) —— id 目标模型与现状差距
- 架构页 [`foundations/dependency-injection.md`](../../architecture/foundations/dependency-injection.md) —— DI 主轴与判断准则
- 架构页 [`foundations/facts-and-projections.md`](../../architecture/foundations/facts-and-projections.md) —— checkpointer 存状态 vs EventLog 存事实流的边界
