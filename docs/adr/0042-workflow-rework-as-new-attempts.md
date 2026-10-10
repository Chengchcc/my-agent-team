# ADR 0042: 返工是新的尝试，不是环

> 来源：issue #79（对照 deepcoldy/botmux 的 `loop` / `revisit` 之后）。决策形状由维护者拍定为「无环补偿」。

## 状态

Accepted（2026-10-10 落地：P1–P5 已实现并各自带测试）

## 上下文

Workflow DSL 表达不出最常见的返工：**「跑 → 验收 → 不过就打回重跑，最多 N 轮」**。

- `parseWorkflow` 以 `topoSort` 收尾（`packages/workflow/src/parse.ts:399`），**对环直接抛 `GraphCycleError`** —— 循环在当前 DSL 里是结构性禁止的，不是没写而已。
- 现有的返工能力只有两处，都不覆盖跨节点打回：
  - `node.retry`：**同一个节点原地重跑**，只针对抛错（`service.ts` 的 `runNodeWithRetry`），并把 `lastError` 喂给下一次尝试；
  - `agent` 节点的 `nextNode` 覆盖：目标必须在**已有边可达**范围内（`graph.test.ts` 钉着），且不改动下游产物的新鲜度。
- 审计面因此是断的：一次「改到通过」的过程在账本里看不出来 —— 既没有第几轮的记录，也没有「为什么被打回」。

同类系统里这个问题已被解决过，形状是**一等公民的返工**（botmux：`loop` 节点表达「跑满 N 轮」，`revisit` 表达「下游把上游连同其下游打回重做，并带上为什么、哪里错」，两者都有次数上限，额度耗尽**只能由人放行**）。

## 决策

**返工 = 一次新的 node run（无环补偿），由显式 rework 边与预算驱动。图仍然无环；被重新进入的是「执行」，不是「图」。**

### 1. DSL：边获得种类与预算

边在 `{from, to, when?}` 之上增加两个可选字段：

- `kind?: "forward" | "rework"`（默认 `forward`）：`rework` 边表示「源节点判定目标（及其下游）的产物不可用，打回重做」；
- `budget?: { maxAttempts: number; onExhausted: "fail" | "human" }`：**rework 边必须声明预算**（缺失即 parse 错误，与「不引入无预算的环」同一条精神）；
- `when` 语义不变（JSONLogic 子集，判定源节点的输出）。

`parseWorkflow` 的既有校验全部保留：**图仍必须无环**、rework 边的两端必须存在、`when` 只能引用已声明输出字段。

### 2. 引擎：打回 = 追加行 + 失效下游

源节点完成且 rework 边的 `when` 成立时：

1. 目标的**尝试序号** = 该 `nodeId` 在此 execution 中已有的 `workflow_node_run` 行数 + 1（**不需要新列**：表本来允许同一 nodeId 多行，`seq` 即历史）；
2. 目标连同**其全部下游**被标记为失效：旧行作为历史保留，重新执行时**追加新行**（与既有「一次执行追加行」的形状一致）；
3. 目标的下一次运行拿到返工上下文，作为输入的显式一段：
   `{ attempt, rework: { from: <源 nodeId>, reason: <源节点的输出/错误摘要> } }` —— 与既有 `retry` 把 `lastError` 喂回同一种做法，只是跨了节点；
4. 预算判定按**目标节点的既有行数**：达到 `maxAttempts` 时，
   - `onExhausted: "fail"`：执行以明确错误终止（错误里带上轮数与最后一次的原因）；
   - `onExhausted: "human"`：落一个 `waiting_human` 门（复用既有 human task 解析端点），答案 `grant` 追加一轮、`reject` 终止执行 —— 对应用户侧「➕ 追加一轮」的卡。

### 3. 确定性不被破坏

- 路由仍在节点完成时**冻结**进 `routedTo`（含 rework 边），执行期不重算计划；
- rework 边是图里**显式声明**的，不是运行时发现出来的；
- 每次尝试都有账本行，因此「哪一轮、为什么、谁放行的」可回溯，而不是藏在一个循环节点的内部状态里。

### 4. 明确不做

- **不引入环**：`topoSort` 的硬约束保留；
- **不把 DSL 变成通用编程语言**：不引入表达式语句、不引入用户自定义循环体；
- **不做无预算的 rework 边**；
- 不改 `retry` 的语义（节点内瞬时失败重试仍归它）。

## 后果

- 一个「执行 → 验收 → 不过则重跑，最多 N 轮，超限停下等人放行」的 workflow 可以被**声明**出来，并且每次尝试都在账本里；
- 代价：引擎的调度状态从「每个 node 一行」变为「每个 node 一行**历史**」，下游失效集合要按图计算（`graph.ts` 需要新增「某节点的后代」这一个纯函数，其余复用）；
- 代价：Web 的时间线要把同一 nodeId 的多行呈现成「第 2 次尝试（因为 X）」而不是重复节点 —— 这是呈现层必须跟上的地方，否则账本对了而人看不懂；
- 代价：`waiting_human` 多了一类语义（grant 预算而不是填表单），human task 的 DTO 需要区分；
- 与 [ADR 0025](0025-loop-workflow-first-execution.md) 无关（Loop 已删）；本 ADR 只动 Workflow DSL 与引擎。

## 落地相位（已全部完成）

```
P1 DSL：边类型 + budget 校验（parse/graph 纯函数 + 测试，无后端改动）        ✓
P2 引擎：尝试序号、下游失效集合、rework 上下文注入（纯域 + 测试）            ✓
P3 服务：追加行、预算耗尽两条出口（fail / waiting_human grant）、事件与 DTO   ✓
P4 呈现：时间线按尝试分组、grant 卡与端点                                    ✓
P5 文档：DSL 手册（skills/agentic-workflow-dsl/SKILL.md）与架构页同步        ✓
```

实现笔记：返工状态不额外持久化——「源行与目标行的最新一行都是 `superseded`」即
「欠一次重跑」，驱动循环每轮从行历史推导，因此重启可续、不需要新列；预算门用
`<node>#budget` 作为自己的行/pending id。

## 关联

- [Workflow 架构页](../architecture/workflow.md) — 现行 DSL 与引擎
- [ADR 0025](0025-loop-workflow-first-execution.md) — Loop（已删，与本 ADR 无关，仅避免重号混淆）
- issue #79 — 需求来源与对照（botmux 的 `loop` / `revisit`）
- `skills/agentic-workflow-dsl/SKILL.md` — 生成侧；P5 必须同步，否则模型会继续生成没有返工的表达
