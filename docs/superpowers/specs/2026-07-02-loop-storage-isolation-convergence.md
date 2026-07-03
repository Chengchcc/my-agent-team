# Loop 存储与隔离收敛 Spec — 状态/预算上 SQLite + 真隔离 + prompt/model 单一真源

> **状态：** 🏗 Design → Implementation
> **基准 HEAD：** `5d467fdd`（`fix(loop): fail-closed repoPath guard, gitCwd safety, fix glob regex patterns`——loop-hardening 落地后的收尾态）
> **所有 `file:line` 均基于 `5d467fdd` 工作树核验，非 dist/.turbo 残留。**
> **关联：** `apps/backend/src/features/loop/loop-step.ts` · `packages/loop/src/{state-md,types,loop-reducer}.ts` · `apps/backend/src/features/cron/scheduler.ts` · `apps/backend/src/features/loop/http.ts` · `skills/loop-engine/{registry.yaml,loop-generator,loop-verifier,loop-triage,loop-config-generator}/SKILL.md` · `docs/adr/0006-loop-lock-deferred.md` · `docs/prd/loop-engineering.md` · `docs/architecture/design-philosophy.md`
> **上游依据：** `design-philosophy.md` 长期主义 / 第一性原则（一个语义对象一套本体；机制不得上浮成业务心智模型；名字即架构；控制回路要统一内模型）。前一里程碑 `2026-07-02-loop-hardening` 已止血，本 spec 把当时以「MVP 不做」为由留下的**机制层结构债**收敛掉。

---

## 0. 出发点：止血已完成，但 loop 的存储机制与系统主线分叉

`2026-07-02-loop-hardening`（现已落进 `5d467fdd`）解决了「回路能跑通且不损坏后端仓库」这类 S1 问题：`repoPath` 从 project 派生、git 命令统一 `.cwd()`、fail-closed guard、per-loop 写锁、预算计数、model≠校验、denylist、VERDICT.md 生命周期都已落地。HEAD 核验，这些已是事实。

**但 loop 在落地这些约束时，选了一条与系统其余部分分叉的机制路径，留下四类结构债 + 一个被写弱的安全边界：**

1. **状态存储分叉**：系统其余部分（conversation / run / cron / project）已在 `2026-06-23-m20-drizzle-orm-migration` + `2026-06-27-storage-convergence` 收敛到 Drizzle + SQLite（按包归属分库）。唯独 loop 的 item 状态真相源是 `STATE.md` / `INBOX.md` 两个扁平 Markdown 文件（`loop-step.ts:259-260`），靠一把进程内 `withLoopLock` Promise 链锁（`loop-step.ts:38-50`）串行化读-改-写。这是**机制层（如何持久化）上浮成了业务真相源**——违反 design-philosophy「机制不得上浮成业务心智模型」「一个语义对象一套本体」。

2. **预算存储再次分叉**：per-loop 日预算是第三套存储——进程内 `Map<string, number>`（`loop-step.ts:53`）+ best-effort 镜像 `budget.json`（`loop-step.ts:59-85`）。`addBudget` 是「读 JSON → 改内存 → 写回 JSON」的非原子序列（`loop-step.ts:72-84`），多入口并发时靠 §1 那把粗粒度写锁兜底。计数本身是一个「按 `(loopId, day)` 累加」的账，天然属于 SQLite 的 `UPDATE ... SET spent = spent + ?` 原子操作，却被拆成了内存 Map + 文件镜像两处，且崩溃即丢内存态、只剩可能落后的 JSON。

3. **死旋钮 `maxParallelFindings`**：`parseLoopConfig` 解析并夹取了 `maxParallelFindings`（`state-md.ts:301/326-328/341`），PRD 与 ADR 0006 都把它标为 P0「AgentSession 并发池」（`loop-engineering.md:157/442`、`0006:13/43`）。但 `loop-step.ts:365` 的 `for (const item of fixingItems)` 是**串行 await**，`maxParallelFindings` 从未被读取消费——它是一个「配置能设、行为不变」的死旋钮。更糟的是：即便真要并行，当前 git 隔离模型（单一 `repoPath` 工作副本 + `git reset --hard baseSha` 回滚，`loop-step.ts:368/414/469`）根本不支持并发——多个 item 共享一个工作树，一个 item 的 `reset --hard` 会抹掉另一个 item 的改动。旋钮与隔离模型互相矛盾，处于「配了会坏、不配是死」的中间态。

4. **prompt / model 真相源分叉成两处**：Generator/Evaluator 的 system prompt 有两套来源——`loop-step.ts:121-148` 的硬编码 `GENERATOR_PROMPT` / `EVALUATOR_PROMPT` 常量，与 `skills/loop-engine/registry.yaml` 每个 pattern 的 `generator.systemPrompt` / `evaluator.systemPrompt`，外加 `skills/loop-engine/{loop-generator,loop-verifier}/SKILL.md` 里的角色 skill 正文。`loop-step.ts:304-305` 用 `cfg?.generator.systemPrompt || GENERATOR_PROMPT` 兜底——即「配置没给就用硬编码」。同一句「你是修 bug 的工程师，绝不能 commit/push」散落在 TS 常量、registry.yaml、SKILL.md 三处，改一处不改其余就会漂移。同理 `GENERATOR_MODEL="claude-sonnet-4"` / `EVALUATOR_MODEL="claude-opus-4"` 硬编码在 `loop-step.ts:151-152`。

5. **fail-closed guard 被写弱（本 spec 的 #0，S1）**：loop-hardening 原意是「绝不对后端自己的 cwd 跑 git mutation」。但 `5d467fdd` 的实现（`loop-step.ts:351-360`）把 throw 条件收窄成了「**仅当** caller 显式接了 `projectPort` 或 `dataDir`、却解析不出 repoPath 时才 throw」：

   ```ts
   if (fixingItems.length > 0 && !repoPath && (params.projectPort || params.dataDir)) {
     throw new Error("loopStep: cannot process fixing items without a resolved repoPath ...");
   }
   const gitCwd = (repoPath ?? ".") as string;   // ← 仍回退到 "."
   ```

   两者都未接（`projectPort` 与 `dataDir` 皆 `undefined`，即测试/遗留 caller）时**不 throw**，`gitCwd` 落到 `"."`——`git reset --hard` 打到后端进程自己的 cwd。这不是「fail closed」，是「fail open with a comment」。安全边界被降级成了测试便利。

一句话：**止血已完成，但 loop 的持久化机制、并发模型、prompt/model 定义各自分叉，且一个安全断路器为了测试便利被降级。本 spec 按长期主义做一次性结构投资：状态与预算收敛到 SQLite（与系统主线同一本体）、并发与隔离二选一收敛（要么删死旋钮、要么上 worktree 真隔离）、prompt/model 收敛到单一真源、fail-closed guard 恢复为无条件断路。**

### 编号体系

- `Cn`：收敛项（存储 / 隔离 / 真源）。
- `Gn`：安全 guard 修复项。
- `Phase n`：施工阶段，按依赖排，每个 = 一个可独立 review 的 PR。

---

## 1. 收敛目标（一句话锚点）

```text
loop 状态真相源 = SQLite（与 conversation/run/cron/project 同一本体）。
  · STATE.md / INBOX.md 降级为「人类可读导出物 / artifact」，不再是真相源。
  · withLoopLock 进程内 Promise 链锁删除，改用 DB 事务 + 行级读改写。

loop 预算账 = SQLite 的一张 loop_budget 表（loop_id, day, spent）。
  · 内存 Map + budget.json 双写删除，改用原子 UPDATE ... SET spent = spent + ?。

并发与隔离 = 二选一收敛，不留中间态：
  · 方案 A（默认推荐）：删死旋钮 maxParallelFindings，明确「单 item 串行」是设计而非缺陷。
  · 方案 B（若确需并行）：per-item git worktree 隔离，回滚 = 删 worktree，旋钮才真实生效。

prompt / model 真相源 = 单一处：
  · system prompt 唯一真源 = registry.yaml（loopStep 只填 {summary}/{source}/{acceptance} 等模板变量）。
  · loopStep 内 GENERATOR_PROMPT/EVALUATOR_PROMPT/GENERATOR_MODEL/EVALUATOR_MODEL 硬编码删除或降为「registry 缺失时的最小 fallback，且 fallback 与 registry 文案一致」。
  · gen≠eval model 校验从 loopStep 运行期上移到 parseLoopConfig 配置加载期，配置加载即失败。

fail-closed guard 恢复为无条件断路：
  · 有 fixing item 且 repoPath 为 null → 无条件 throw，删掉 (projectPort || dataDir) 前置条件。
  · 删掉 gitCwd = repoPath ?? "." 的 "." 回退。
  · 测试便利改由注入 no-op gitRunner / dryRun 提供，而非让生产代码回退到 cwd。
```

---

## 2. C1 — loop 状态上 SQLite（修复 §0#1）

### 2.1 现状

- 真相源：`${loopConfigPath}/STATE.md`（active items）+ `${loopConfigPath}/INBOX.md`（inbox items），`loop-step.ts:259-260/277-288`。
- 读：`parseStateMd` / `parseInboxMd`（`state-md.ts`）。写：`formatStateMd` / `formatInboxMd`，在 `writeStateAndInbox`（`loop-step.ts:217-242`）末尾一次性 `Bun.write`。
- 并发保护：`withLoopLock`（`loop-step.ts:38-50`）——模块级 `Map<loopConfigPath, Promise>` 链，把整个 `loopStepImpl` 串行化（`loop-step.ts:254-256`）。
- 问题：这是与系统主线（Drizzle + SQLite）分叉的第二套持久化本体。锁是进程内的（多实例部署即失效，ADR 0006 自承），Markdown 往返编解码脆（reasons 曾用 `split(",")`，见 `state-md.ts:280-287` 现已 JSON 兜底但仍是文本协议）。

### 2.2 决策：SQLite 为真相源，Markdown 降级为导出物

- 新增 `loop_item` 表（归属 backend 包，落 `backend.db`——与 `2026-06-27-storage-convergence`「按包归属分库」一致，不新开文件）：

  ```text
  loop_item(
    loop_id     TEXT NOT NULL,
    item_id     TEXT NOT NULL,           -- ULID
    source      TEXT NOT NULL,
    summary     TEXT NOT NULL,
    step        TEXT NOT NULL,           -- ItemStep 7 值 union
    attempt     INTEGER NOT NULL,
    priority    INTEGER NOT NULL,
    result      TEXT,                    -- Verdict JSON | null
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (loop_id, item_id)
  )
  ```

  字段与 `packages/loop/src/types.ts` 的 `ItemState`（`id/source/summary/step/attempt/priority/result`）逐字段对应；`result` 存 `Verdict` 的 JSON 序列化。

- `loopReducer` **保持纯函数不变**（`packages/loop/src/loop-reducer.ts`，输入 `LoopState` 输出 `LoopState`）——它是控制回路的统一内模型（Good Regulator），不碰持久化。变的只是「`LoopState` 从哪读、往哪写」。
- 引入 **`LoopStateStore` port**（backend 侧），把「读整个 loop 的 items → LoopState」「写回 LoopState」两个操作收口：

  ```ts
  interface LoopStateStore {
    load(loopId: string): LoopState;                 // 从 loop_item 表聚合
    save(loopId: string, next: LoopState): void;     // 事务内 upsert active + 移动 inbox/terminal
  }
  ```

  `loopStepImpl` 用 `store.load(loopId)` 替代 `parseStateMd(await Bun.file(statePath)...)`，用 `store.save(loopId, finalState)` 替代 `writeStateAndInbox` 的 `Bun.write`。
- **并发**：`save` 在单个 DB 事务内完成（`bun:sqlite` 同步调用 + JS 事件循环天然串行化写入，WAL 允许并发读；与 storage-convergence 对「单写者」的论断一致）。据此**删除 `withLoopLock`** 及 `loop-step.ts:254-256` 的包裹——真相源换成事务后，进程内 Promise 锁不再是正确性所需。
  > 若保留「同一 loop 的 cron 触发不重叠」语义，交给 cron scheduler 现有的 `inFlight`（防同 job 重叠触发），不与状态一致性耦合。
- **Markdown 降级**：`STATE.md` / `INBOX.md` 不再是真相源。保留「每次 `save` 后从 DB 渲染一份 `STATE.md` 到 `${loopConfigPath}/` 作人类可读 artifact」为**可选**导出（best-effort，失败不影响事务）——或直接由 Web 详情页 API 实时读 DB，Markdown 仅在用户显式导出时生成。二选一在 plan 里定。

### 2.3 迁移安全

- Drizzle migration 新建 `loop_item` 表；若已有存量 loop（`STATE.md`/`INBOX.md`），提供一次性 import 脚本：`parseStateMd`/`parseInboxMd` 读旧文件 → `store.save`。人工核验生成 SQL 不含意外 drop（对齐 storage-convergence 的 migration 安全条款）。

---

## 3. C2 — 预算账上 SQLite（修复 §0#2）

### 3.1 现状

- `budgetCounters = new Map<string, number>()`（`loop-step.ts:53`），key = `${loopId}:${utcDay}`（`loop-step.ts:362`）。
- `loadBudget`（`59-70`）：内存命中即返回，否则读 `budget.json`。`addBudget`（`72-85`）：改内存 → 读 JSON → 改 → 写回 JSON。整个「读-改-写」非原子。
- 计数来源：`tallyUsage`（`87-103`）从 `spec.checkpointer.readEvents(sessionId)` 累加 `model_end.usage.input+output`（不直接调 LLM Gateway，合规）。
- 闸门：`loop-step.ts:363/366/382-388/441-447`——`spent >= dailyCap` 则 `break`，每个 session 完成后 `addBudget`。

### 3.2 决策：一张 loop_budget 表 + 原子 UPDATE

- 新增 `loop_budget(loop_id TEXT, day TEXT, spent INTEGER, PRIMARY KEY(loop_id, day))`（backend.db）。
- 累加改为单条原子语句：`INSERT INTO loop_budget(loop_id, day, spent) VALUES(?,?,?) ON CONFLICT(loop_id, day) DO UPDATE SET spent = spent + excluded.spent`。读：`SELECT spent FROM loop_budget WHERE loop_id=? AND day=?`。
- **删除** `budgetCounters` Map（`loop-step.ts:53`）、`loadBudget`/`addBudget` 的 `budget.json` 读写（`59-85`）。`tallyUsage`（token 事实来源）**保留不变**——它只负责「本次 session 花了多少 token」，与「账存哪」正交。
- 闸门语义不变：起 generator/evaluator session 前 `spent < dailyCap`；`dailyCap=0` 表示不限（`loop-step.ts:308` 现状），保持。
- 收益：崩溃不丢账（DB 持久）；多入口并发累加天然原子（不依赖 §2 那把已删的粗锁）；与状态同库同事务语义，机制统一。

---

## 4. C3 — 并发与隔离二选一收敛（修复 §0#3）

死旋钮 `maxParallelFindings` 与「单工作树 + reset --hard」隔离模型互斥。必须选一条，不留中间态。

### 4.1 方案 A（默认推荐）：删旋钮，明确单 item 串行是设计

- 从 `LoopConfig`（`state-md.ts:301`）删除 `maxParallelFindings` 字段及其解析（`state-md.ts:326-328/341`）。
- 在 PRD `loop-engineering.md:157/442` 与 ADR 0006 记录：**MVP 明确采用单 item 串行**——`git reset --hard` 隔离模型下串行是正确性所需，不是性能缺陷；并发池作为「未来若引入 worktree 隔离再启用」的开放项，而非一个存在但失效的配置面。
- 理由（长期主义）：一个「配了会坏、不配是死」的旋钮，是把未完成的机制泄漏成了业务配置面（违反「机制不得上浮成业务心智模型」）。删掉它比留着它更接近最小熵——决策空间没有损失，反而消除了误配陷阱。

### 4.2 方案 B（若确需并行）：per-item git worktree 真隔离

- 每个 fixing item 分配独立 `git worktree`：`git worktree add ${repoPath}/.worktrees/${itemId} ${baseSha}`，该 worktree 根即该 item generator/evaluator session 的 cwd 与所有 git 命令的 cwd。
- 回滚语义从 `git reset --hard baseSha`（`loop-step.ts:414/469`，会污染共享工作树）改为 `git worktree remove --force ${worktreePath}`——删 worktree 即回滚，item 之间物理隔离。
- 并发消费 `maxParallelFindings`：有界信号量（手写，禁止引入 `p-limit` 等新依赖除非已在树内），上限 = `maxParallelFindings`。`loop-step.ts:365` 的串行 `for...of` 改为受限并发。
- 状态写回：并发产生的 verdict 各自 `store.save`（§2 已让 save 走事务，行级 upsert 不互相覆盖）；或收集所有 verdict 后在末尾统一 reduce + save（plan 定）。
- 复杂度显著高于方案 A。**决策：除非有真实的「单 loop 多 finding 且时延敏感」诉求，否则取方案 A。** 本 spec 默认方案 A；方案 B 作为备选完整记录，由 plan 的实施者按当时诉求勾选其一。

---

## 5. C4 — prompt / model 收敛到单一真源（修复 §0#4）

### 5.1 现状

- system prompt 三处：`loop-step.ts:121-148` 硬编码常量、`registry.yaml` 每 pattern 的 `generator/evaluator.systemPrompt`、`skills/loop-engine/{loop-generator,loop-verifier}/SKILL.md` 角色 skill 正文。
- `loop-step.ts:304-305`：`cfg?.generator.systemPrompt || GENERATOR_PROMPT`——配置缺失回退硬编码。
- model：`loop-step.ts:151-152` 硬编码 `GENERATOR_MODEL`/`EVALUATOR_MODEL`，`loop-step.ts:299-300` 用 `cfg?.…model ?? …` 兜底。
- 校验：`loop-step.ts:301-303` gen≠eval model 在 loopStep **运行期**才 throw（item 已进 fixing 才失败）。

### 5.2 决策

- **system prompt 唯一真源 = registry.yaml。** LOOP.md（由 loop-config-generator 从 registry pattern 派生）承载 `generator.systemPrompt`/`evaluator.systemPrompt`。`loopStep` 只负责把模板变量（`{summary}`/`{source}`/`{acceptance}`/`{filesChanged}`/`{rejectionNote}`，见 `loop-step.ts:244-252/420-422`）填进 prompt。
- **删除或降级** `loop-step.ts:121-148` 的 `GENERATOR_PROMPT`/`EVALUATOR_PROMPT` 常量：
  - 首选删除，`parseLoopConfig` 保证 `generator.systemPrompt`/`evaluator.systemPrompt` 非空（缺失即配置无效，见下），则 `loopStep` 不再需要 fallback。
  - 若为兜底鲁棒性保留最小 fallback，则该 fallback 文案必须与 registry.yaml 的通用 pattern **一致**（同一句话只写一遍并在两处引用同源，或明确标注「fallback 副本，改 registry 时同步」）。
- **model 同理**：`GENERATOR_MODEL`/`EVALUATOR_MODEL` 硬编码删除，model 由 registry/LOOP.md 提供；`parseLoopConfig` 已要求 `gen.model`/`eval_.model` 存在（`state-md.ts:321` `if (!gen?.model || !eval_?.model) return null`），缺失即 config 无效，无需 TS 常量兜底。
- **gen≠eval 校验上移到配置加载期**：把 `loop-step.ts:301-303` 的检查移进 `parseLoopConfig`（`state-md.ts:311-345`）——`gen.model === eval_.model` 时 `parseLoopConfig` 视为无效配置（返回 `null` 或抛带明确信息的错误）。收益：配置加载即失败（创建 loop / 保存 LOOP.md 时就报），而非等到 cron 触发、item 已进 fixing 的运行期才崩。对齐 flow「Evaluator model ≠ generator」与 PRD「分模型独立 AgentSession」。
  > 注意：`parseLoopConfig` 现返回 `LoopConfig | null`。校验失败若走「返回 null」，需确保上层（`loop-step.ts:292-297` catch 后 `cfg=null`）不会把「配置非法」静默当成「无配置」而用默认 model 跑下去——因此非法配置应**抛错**而非返回 null，或上层对 null 来源区分。plan 里定实现方式。

---

## 6. G0 — fail-closed guard 恢复无条件断路（修复 §0#5，S1）

### 6.1 现状（`loop-step.ts:351-360`）

```ts
if (fixingItems.length > 0 && !repoPath && (params.projectPort || params.dataDir)) {
  throw new Error("loopStep: cannot process fixing items without a resolved repoPath ...");
}
const gitCwd = (repoPath ?? ".") as string;
```

`projectPort` 与 `dataDir` 皆 undefined 时不 throw，`gitCwd = "."` → `git reset --hard`（`loop-step.ts:414/469`）打到后端进程 cwd。

### 6.2 决策

- 断路条件收敛为无条件：**有 fixing item 且 `repoPath` 为 null → 一律 throw**，删掉 `(params.projectPort || params.dataDir)` 前置条件。

  ```ts
  if (fixingItems.length > 0 && !repoPath) {
    throw new Error("loopStep: cannot process fixing items without a resolved repoPath ...");
  }
  ```

- **删掉 `gitCwd = repoPath ?? "."` 的 `"."` 回退**。走到 git 命令处 `repoPath` 必然非 null（上面已 throw），`gitCwd = repoPath`。
- **测试便利另辟安全通道**，不让生产代码回退到 cwd：
  - 首选：给 `loopStep` 注入一个可选的 `gitRunner`（默认 = 真实 `Bun.$().cwd(repoPath)`），测试传 no-op / 内存 stub，从而无需真实 repo 也不碰后端 cwd。
  - 或：给测试专用的 `dryRun` 开关，`dryRun` 下跳过所有 git mutation。
  - 二选一在 plan 定；关键是**测试不再依赖「repoPath 缺失时静默回退到 cwd」这一危险行为**。
- 对齐 §0#5 与 design-philosophy「安全断路器不得为便利降级」：fail closed 必须真的 closed。

---

## 7. 验收标准

- [ ] `loop_item` / `loop_budget` 表建成并落 `backend.db`；Drizzle migration 人工核验无意外 drop。
- [ ] loopStep 的 item 状态读写全走 `LoopStateStore`（DB 事务）；`STATE.md`/`INBOX.md` 不再是真相源（可保留为导出 artifact）。
- [ ] `withLoopLock` 及其包裹删除后，并发 run+review 对同一 loop 无状态覆盖丢失（并发测试，改由事务保证）。
- [ ] 预算累加走原子 `UPDATE ... SET spent = spent + ?`；`budgetCounters` Map 与 `budget.json` 读写删除；崩溃重启后账不丢（持久化测试）。
- [ ] `dailyCap` 闸门语义不变：`spent >= dailyCap` 时该 item 跳过（回归测试）；`dailyCap=0` 不限。
- [ ] （方案 A）`maxParallelFindings` 字段与解析从 `state-md.ts` 删除，PRD/ADR 记录「单 item 串行是设计」；**或**（方案 B）per-item worktree 隔离落地，回滚 = `git worktree remove`，`maxParallelFindings>1` 时真实并发且 item 间无相互污染（并发隔离测试）。二者不共存。
- [ ] system prompt 唯一真源 = registry.yaml；`loop-step.ts` 的 `GENERATOR_PROMPT`/`EVALUATOR_PROMPT` 删除或降为与 registry 同源的最小 fallback。
- [ ] `GENERATOR_MODEL`/`EVALUATOR_MODEL` 硬编码删除，model 由配置提供。
- [ ] gen≠eval model 校验在 `parseLoopConfig`（配置加载期）失败，而非 loopStep 运行期；非法配置不被静默当成「无配置」跑默认 model（区分测试）。
- [ ] fail-closed：`projectPort`/`dataDir` 皆未接且有 fixing item 时 loopStep **抛错**（不再静默用 `"."`）；`gitCwd` 无 `?? "."` 回退。
- [ ] 后端仓库有未提交改动的场景跑 loop，后端仓库改动**无损**（G0 回归测试，沿用 loop-hardening §10 同款场景）。
- [ ] `bun run typecheck` + `bun test` 全绿。

---

## 8. 后续项（本 spec 不做）

- 多实例部署的分布式协调（当前单进程 + DB 事务；跨实例锁另议）。
- 若选方案 A，worktree 真并行作为独立里程碑（需要时再启用 `maxParallelFindings`）。
- registry.yaml → LOOP.md 的版本控制 / diff 策略（PRD 开放问题）。
- denylist 的工具层强制拦截（loop-hardening 已记为后续项，本 spec 不动）。
