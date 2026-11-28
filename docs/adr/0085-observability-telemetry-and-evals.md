# ADR 0085: 可观测性与功能评测体系 — 性能遥测闭环与 Skill / Workflow 回归评测

- **状态**：Implemented（2026-11-28 全 3 期落地并验证）
- **日期**：2026-11-28
- **相关**：[设计哲学](../architecture/design-philosophy.md)、[系统总览](../architecture/system-overview.md)、[Workflow 引擎](../architecture/workflow.md)、[ADR 0051](./0051-authorization-chain.md)（Run 派单授权链）、[ADR 0057](./0057-front-desk-prompt-discipline.md)（前台路由纪律）、[ADR 0077](./0077-requirement-owns-the-workspace.md)（需求工作区隔离）、[ADR 0082](./0082-cross-surface-linkage-human-labels-and-channels.md)（跨工作面关联）、[ADR 0084](./0084-workflow-as-pa-managed-team-sop.md)（Workflow Git 留痕与 SOP）

## 背景与问题

CrewDesk 当前的观察页面（`/system` 与 `/system/runs/[runId]`）仅覆盖了基础的运行清单、进程 RSS 与单张 Token 面积图，远不足以支撑团队对 Agent 系统的两大核心诉求：**性能观察（Performance & Reliability Observability）** 与 **功能评测（Skill / Workflow / Agent Functional Evals）**。

盘点现有代码（`apps/web/src/app/(main)/system/page.tsx`、[runtime-ops/store.ts](../../apps/backend/src/features/runtime-ops/store.ts)、[RunWaterfall.tsx](../../apps/web/src/components/ops/RunWaterfall.tsx)）后，具体存在 6 处结构性缺口：

1. **后端已计算的遥测资产在前端被丢弃**：`RuntimeOpsStore.telemetrySummary()` 已经计算出 `failureCauses`、`spinningRuns`（空转检测）、`successRateByDay`（7 日成功率）、`durationByDay`（7 日耗时）与 `failures`，而 [wiring-agent-run.ts](../../apps/backend/src/bootstrap/wiring-agent-run.ts) 与 [wiring-routes.ts](../../apps/backend/src/bootstrap/wiring-routes.ts) 也已持久化了 `unasked_question`、`irreversible_unasked`、`unrouted_work`、`answer_corrected` 等行为质量事件，但前端 `/system` 一概未展示。
2. **关键性能指标存在采集与聚合盲区**：
   - `agent_run.terminal_result` 已保存 `cacheReadTokens` / `cacheWriteTokens`，但遥测层未聚合 **Prompt Cache 命中率**（对多轮 Agent 循环而言，Cache 失效率直接决定成本与延迟是否翻倍）；
   - 仅统计易被长尾扭曲的 `avgDurationMs`，缺少 **P50 / P95** 分位数与 **TTFT（首字延迟）**；
   - `RunWaterfall` 通过工具间隙反推 `model turn`，把 HITL 等待人类审批/回答的 `waiting` 时间错误算进了模型耗时；
   - 缺少按 **Tool** 维度的调用量、错误率、P95 耗时统计，也缺少 **Skill 实际激活** 埋点（`agent_run.skill_roots` 仅记录“可用目录”，无法得知实际加载了哪个 Skill）。
3. **单次 Run 排障深度不足**：`/system/runs/[runId]` 仅展示 1 跳 `Dispatched units` 而非完整多跳派发树；事件列表仅渲染单行 `eventLine`，无法展开工具入参/出参，也未暴露 `agent_run` 中已冻结的 `system_prompt` 与 `skill_roots` 快照。
4. **缺少面向 Skill 与 Workflow 的功能评测体系**：全仓仅有独立 CLI 脚本 [scripts/golden-intent.ts](../../scripts/golden-intent.ts) 覆盖前台路由分类；改完 Skill、Prompt、Model 或 Workflow 后，缺乏可复用的评测集、分层评分器、`pass^k` 稳定性度量以及版本间 A/B Diff 对比。
5. **缺少评测隔离与成本护栏**：Agent 与 Workflow 运行会修改工作区文件、调用外部通道或消耗高额 Token，若直接在生产上下文中试跑评测，既会污染工作树与统计大盘，也存在预算失控风险。
6. **生产观测与离线评测割裂**：线上出现的真实失败、空转与人工纠偏（`answer_corrected`）无法一键沉淀为回归用例，难以形成“线上发现 → 沉淀用例 → 改后回归 → 线上验证”的闭环。

## 核心定位

遵循 [设计哲学](../architecture/design-philosophy.md)（**统一本体、不复制语义；暴露领域、隐藏机制；边界要硬、概念要少**）：

> **CrewDesk 不再造一套外挂式通用 Trace/Span 平台，也不维护第二套评测 Runner。性能观察直接扎根于 `Agent Run` 与 `Workflow Execution` 单一事实源；功能评测只引入 `EvalSuite` 与 `EvalRun` 两个领域对象，其每一次评测执行本身就是一次受隔离的真实 `Agent Run` 或 `Workflow Execution`。**

## 架构决策

### D1. 本体边界：性能观察零新实体，评测仅增 `EvalSuite` 与 `EvalRun`

- **性能观察复用既有实体**：多智能体调用链由 `agent_run.parent_run_id`（ADR 0051）递归构建，工作流节点由 `workflow_node_run.run_id` 关联到对应 `agent_run`，工具明细由 `agent_run_event` 与 `product_tool_call` 提供。**严禁**新增平行的 `trace` / `span` 领域表。
- **评测执行复用真实执行管线**：每一次评测 Case 尝试（trial）直接调用现有 `Agent Run` 或 `Workflow Execution` 执行器，产出的轨迹、瀑布图、Token 与费用天然兼容 `/system/runs/[runId]` 与 `/workflows/:id` 详情页。
- **仅新增两个领域概念**：
  1. **`EvalSuite`（评测集）**：面向某个 `skill`、`workflow` 或 `agent` 的版本化用例与评分规则定义；
  2. **`EvalRun`（评测实验）**：某次评测运行的不可变实验记录（模型、目标版本快照、重复次数 `k`、预算上限、聚合指标），下挂每个 Case Trial 到真实 `runId` / `executionId` 的结果行。

### D2. 补齐 4 类性能采集盲区与行为质量聚合

在不破坏现有事件契约的前提下，补齐以下低侵入埋点与 SQL 聚合：

1. **Prompt Cache 命中率与成本拆分**：
   - 在 `RuntimeOpsStore.telemetrySummary()` 中聚合 `terminal_result.usage.cacheReadTokens` 与 `cacheWriteTokens`，新增字段：`cacheReadTokens`、`cacheWriteTokens`、`cacheHitRate`（定义为 `cacheRead / (input + cacheRead)`，分母为 0 时为 `null`），并在 `byModel` 与 `byAgent` 明细中同步透出。
2. **三段耗时拆分（`model` / `tool` / `human_wait`）与 TTFT**：
   - 在 `pending_action` 创建与解决钩子处向 `agent_run_event` 写入 `waiting_started` 与 `waiting_resumed`（跨所有 ACP harness 零侵入生效）；
   - 在 `oma` ACP 事件流及 [event-mapping.ts](../../apps/backend/src/features/agent-run/acp/event-mapping.ts) 补发 `llm_turn_started`（含首字到达时的 `ttftMs`）与 `llm_turn_completed`（含该轮 token 用量）；对未发此事件的其他 harness，瀑布图自动降级为“总耗时扣除 `tool` 与 `human_wait` 区间”估算，不再把人类等待时间误算为模型慢。
   - 汇总指标补齐 **`p50DurationMs` / `p95DurationMs`**（基于剥离 `human_wait` 后的纯执行耗时 `activeDurationMs`）与 **`p50TtftMs` / `p95TtftMs`**。
3. **Tool 级健康度与可展开 Payload**：
   - 汇总 `agent_run_event`（`native_tool_started` / `native_tool_completed`）与 `product_tool_call`，新增 `toolStats`（按工具名统计 `calls`、`errors`、`errorRate`、`p50Ms`、`p95Ms`）；
   - `native_tool_started` 与 `native_tool_completed` 持久化时保留脱敏截断后的入参/出参摘要（单字段上限 2 KiB，自动掩码常见密钥模式），供单 Run Trace 展开检查，且不扩大前端实时卡片广播负载（守住 ADR 0033）。
4. **Skill 激活埋点与行为质量信号聚合**：
   - 当 Agent 读取位于其 `skill_roots` 下的 `SKILL.md` 时，记录 `skill_activated` 事件（`{ skillName, path }`），支撑按 Skill 维度的触发频次/耗时/成功率聚合与评测断言；
   - 在 `telemetrySummary()` 中新增 `qualitySignals`，直接聚合已落库的 `unasked_question`、`irreversible_unasked`、`status_question_dispatched`、`unrouted_work`、`answer_corrected` 五类计数及关联 Run 列表。

### D3. 升级 Web `/system`（性能观察）与 `/system/runs/[runId]`（Trace 检视）

- **观察模块信息架构**：在 `/system` 顶部提供清晰的工作区切换：
  - **性能观察（`/system`）**：聚焦生产运行健康、性能瓶颈与成本；
  - **功能评测（`/system/evals`）**：聚焦 Skill / Workflow / Agent 回归测试与版本 A/B 对比；
  - **授权台账（`/system/authority`）**：保留既有权限与主动触发审计视图。
- **`/system` 性能观察升级**：
  - 时间窗扩展为 `1h / 24h / 7d / 30d`；
  - 增加筛选条：`Agent`、`Model`、`Status`、`Skill` 与 `Scope`（默认 `production` 剔除评测 Run，可切换 `eval` 或 `all`）；
  - 概览区接入后端已算好但此前丢弃的数据：`7d 成功率与 P95 耗时趋势`、`失败归因分布（timeout / schema / permission / network / other）`、`Cache 命中率`、`空转告警（spinningRuns）` 与 `行为质量信号（qualitySignals）`；
  - Tab 重组为 **`Overview`（或顶部健康条 + 图表） / `Runs` / `Tools` / `Usage` / `Processes`**，其中 `Runs` 补齐纯执行耗时列、Cache 命中列与子 Run 计数徽标，`Tools` 展示工具维度 P95 耗时与错误率排行。
- **`/system/runs/[runId]` 升级为真 Trace 视图**：
  - **递归派发树**：从当前 Run 向上溯源到 Root Run、向下递归展开全部子 Run，标注每跳状态、纯执行耗时与汇总成本；
  - **三色瀑布图**：升级 [RunWaterfall.tsx](../../apps/web/src/components/ops/RunWaterfall.tsx) 区分 `model` / `tool` / `human_wait`，点击任意工具条展开截断后的 Input / Output JSON；
  - **冻结上下文快照面板**：折叠展示 `agent_run.system_prompt`、`skill_roots`、本次实际触发的 `skill_activated` 列表与 `input / output / cacheRead / cacheWrite` 明细。

### D4. `EvalSuite` 单一事实源：`<dataDir>/evals/*.eval.json` + 本地 Git 自动留痕

采用与 ADR 0084（`<dataDir>/workflows/*.workflow.json`）一致的文件系统单一事实源模式：

- **存储与版本化**：
  - 每个评测集是一个自包含的 JSON 文件，存于 `<dataDir>/evals/<suiteId>.eval.json`；
  - 复用 ADR 0084 的本地 Git 自动留痕模式（`git init`、`tmp + rename` 原子写、每次保存/删除/导入自动提交带作者信息的 git commit），暴露只读历史与一键回滚；
  - 同一份 `.eval.json` 既可通过 Web UI 创建与编辑，也可随仓库进 Git 由 CLI / CI 执行。
- **统一覆盖三类评测目标（`target.kind`）**：
  - **`skill`**：指定 `skillName`（以及可选 `agentId`、测试用工作区夹具），验证 Skill 触发准确性与任务完成度；
  - **`workflow`**：指定 `workflowId`（与可选 git commit ref），喂入触发 `input` 变量，端到端验证整条 SOP；
  - **`agent`**：指定 `agentId`（如前台 PA 路由评测），直接吸收 [scripts/golden-intent.ts](../../scripts/golden-intent.ts) 的用例集成为开箱即用的内置示例 Suite。
- **最小 Schema 契约**：
  - 顶层：`id`、`name`、`description`、`target: { kind: "skill" | "workflow" | "agent", ref: string, agentId?: string }`、`defaultModel?: string`、`defaultTrials?: number`、`budget?: { maxTotalCostUsd?: number, concurrency?: number }`、`cases: EvalCase[]`；
  - 单用例 `EvalCase`：`id`、`name`、`tags?: string[]`、`input`（自然语言消息或 Workflow 输入对象）、`fixture?: { projectId?: string, ref?: string, files?: Record<string, string> }`、`graders: GraderSpec[]`、`budget?: { maxDurationMs?: number, maxToolCalls?: number, maxCostUsd?: number }`、`trials?: number`。

### D5. 三层评分器（Graders）与 `pass@k` / `pass^k` 稳定性指标

针对 Agent 的非确定性，评分器按“确定性优先、轨迹约束兜底、语义裁判可选”三层组合：

1. **Layer 1 — Deterministic / Contract Graders（代码硬断言，零 LLM 成本，推荐默认）**：
   - `skill_activated`：断言目标 Skill 必须（或禁止）触发；
   - `tool_called` / `tool_forbidden`：断言某工具被调用（或未被调用），支持对入参做键值/正则子集匹配；
   - `workflow_outcome`：断言 Workflow 终态 `status`、`exit` 分支、必须经过的 `nodeId` / `routedTo` 序列、无非预期 `budget_exhausted`；
   - `output_match`：对最终回复或节点输出做子串、正则或 JSON Schema 校验（兼容前台路由 `action / verb / missingSlots` 契约）；
   - `command_check`：代码类用例在隔离 worktree 内通过 `@chengchenccc/sandbox` 执行指定校验命令（如单测/类型检查），以退出码判定。
2. **Layer 2 — Trajectory & Budget Graders（过程效率约束，自动生效）**：
   - 断言 `toolCalls <= maxToolCalls`、`activeDurationMs <= maxDurationMs`、`costUsd <= maxCostUsd`、`spinning === false`，防止模型通过死循环或暴力试错“蒙对”最终答案。
3. **Layer 3 — LLM-as-a-Judge（按需启用，非默认）**：
   - 仅当 Case 显式配置 `rubric` 时触发，使用独立配置的评审模型输出结构化 `{ pass: boolean, score: 1..5, reason: string }`，适用于代码 Review、调研报告、文档写作等开放式产物。
4. **实验存储与稳定性指标（SQLite）**：
   - 新增 2 张执行结果表：`eval_run`（记录 `evalRunId`、`suiteId`、`suiteCommit`、`label`、`targetSnapshot`、`modelRef`、`status`、`trials`、`concurrency`、`maxTotalCostUsd`、`summaryJson`、`createdAt`、`terminalAt`）与 `eval_case_result`（记录 `evalRunId`、`caseId`、`trialIndex`、`runId`、`workflowExecutionId`、`passed`、`score`、`graderResultsJson`、`activeDurationMs`、`toolCalls`、`inputTokens`、`outputTokens`、`cacheReadTokens`、`costUsd`、`error`）；
   - 当 `trials = k > 1` 时，自动计算并展示 **`pass@k`**（至少 1 次通过，反映能力上限）与 **`pass^k`**（连续 k 次全通过，反映生产稳定性）。
   - Web `/system/evals` 提供 **A/B Diff 对比视图**：任选两次 `EvalRun`（Baseline vs Candidate），并排展示总通过率、`pass^k`、P95 耗时、总费用与 Cache 命中率变化，并置顶高亮 **`Pass → Fail` 回归项**与 **`Fail → Pass` 修复项**，每条均可直达对应的 `/system/runs/[runId]` Trace 页面。

### D6. 隔离执行与成本护栏

1. **遥测与通道隔离**：
   - 评测启动的 `Agent Run` 携带 `authorization = "eval:<evalRunId>"`，评测启动的 `Workflow Execution` 携带 `triggered_by = "eval:<evalRunId>"`；
   - `/system` 生产大盘默认过滤 `eval:*` 来源；评测产生的终态结果**绝不**向飞书群或人类默认会话回流通知，也不污染 `/today` 收件箱。
2. **工作区隔离**：
   - 带 `fixture.projectId` 的代码类用例复用 ADR 0077 的项目 git mirror，在独立临时 worktree（位于临时评测目录，不创建生产 `Requirement` 行）内运行，执行与 `command_check` 完成后自动回收 worktree，零污染现有需求分支。
3. **外部副作用拦截（Dry-run Product Tools）**：
   - 评测上下文中，不可逆或外发类工具（如飞书外发、不可逆 `operate`、外部写操作）默认进入记录拦截模式（dry-run stub）：返回模拟成功回执并将完整调用参数写入 `product_tool_call` / `agent_run_event`，供 `tool_called` Grader 断言而不触发真实外部影响。
4. **并发上限与预算硬熔断**：
   - `EvalRun` 默认 `concurrency = 2`（可调但有服务端硬上限），并支持设置 `maxTotalCostUsd`；每次 Case 结束即时累计实际开销，触顶立即取消未启动 Case 并将实验终结为 `budget_stopped`；
   - 支持 **单 Case 试跑** 与 **一键仅重跑失败 Case**，避免微调 Prompt 时反复重跑已通过用例。

### D7. 生产 → 评测闭环飞轮

- **轻量运行反馈表（`run_feedback`）**：新增 1 张轻量化标注表（主键 `feedback_id`，关联 `run_id` 或 `workflow_execution_id`，记录 `rating: "up" | "down"`、`tags`（如 `wrong_tool` / `missed_skill` / `hallucination` / `slow`）、`note`、`promoted_suite_id`、`promoted_case_id`、`created_at`），不破坏 `agent_run` 不可变终局记录。
- **一键沉淀为评测用例**：在 `/system/runs/[runId]` 与 Workflow 执行轨迹页提供 👍/👎 归因标注和 **「加入评测集」** 按钮——自动提取该次执行的输入消息/Workflow 参数、触发过的 Skill/工具作为预填草稿，确认后原子写入目标 `<dataDir>/evals/<suiteId>.eval.json` 并自动 git commit。
- **与 ADR 0084 联动**：在 Workflow 详情页与 Skill 列表页展示关联 `EvalSuite` 的最近一次通过率与回归趋势，修改 Workflow 或 Skill 后可一键触发回归测试并查看 Diff。

## 分阶段实施路线

### Phase 1：性能观察止血与 Trace 升级（零新表、快速见效）
1. 后端：`RuntimeOpsStore.telemetrySummary()` 补齐 `cacheHitRate`、`p50/p95`、`toolStats`、`qualitySignals`、多维筛选（`window` / `agentId` / `modelId` / `skill` / `scope`）；补齐 `waiting_started/resumed`、`skill_activated`、`llm_turn_started/completed`（含 TTFT）与截断 Tool I/O 埋点；新增单 Run 递归派发树接口。
2. 前端：升级 `/system`（接入已有 7d 趋势、失败归因、空转告警、行为质量信号、Cache 命中率与新增 `Tools` Tab）与 `/system/runs/[runId]`（递归 Trace 树、三色 Waterfall、可展开 Tool I/O、冻结 Prompt/Skill 快照面板）。

### Phase 2：Skill / Workflow 功能评测引擎与 Web A/B 对比
1. 后端：实现 `<dataDir>/evals/*.eval.json` Git 留痕存储、SQLite 迁移（`eval_run` + `eval_case_result`）、三层 Grader 引擎、隔离 worktree & dry-run 拦截器、并发/预算熔断调度器与 HTTP API；将 `scripts/golden-intent.ts` 的用例迁入标准内置 `EvalSuite`。
2. 前端：新增 `/system/evals`（评测集列表与编辑、发起实验、实时进度、单 Case 结果与一键跳转 Run Trace、Baseline vs Candidate A/B Diff 对比、仅重跑失败项）。

### Phase 3：生产 → 评测飞轮闭环
1. 后端：新增 `run_feedback` 迁移与标注/一键提升为 `EvalCase` 接口。
2. 前端：在 `/system/runs/[runId]` 与 Workflow 轨迹页挂载反馈标注与「加入评测集」弹窗；在 Workflow 详情页（ADR 0084）和 Skill 页接入关联评测集状态与一键回归入口。

## 拒绝的方案

1. **强依赖外部 OTel Collector / ClickHouse / Langfuse 部署**：CrewDesk 定位于单机零外部运维依赖（单一 SQLite 文件），内置控制面已持有全部执行事实；若未来需要对接外部监控系统，只需在 `agent_run_event` 侧挂只读 OTLP 导出器，不改变内部真相源。
2. **新建平行的 `trace` / `span` 表或独立评测 Runner**：违反 [设计哲学](../architecture/design-philosophy.md) 单一本体原则，会导致生产执行与评测执行出现行为漂移（测的不是线上跑的同一套代码）。
3. **评测集仅存 SQLite 不落盘**：无法进行 Git 版本对比、PR 审查与 CLI/CI 复用，也与 ADR 0084 的 Workflow 文件模型割裂。
4. **默认所有 Case 启用 LLM-as-a-Judge**：慢、贵、评分漂移大；80% 的 Skill 触发、工具路径、Workflow 路由与代码校验应由 Layer 1 硬断言 + Layer 2 轨迹预算零成本拦截，LLM Judge 仅作可选补充。

## 验收标准

- **Phase 1**：
  1. `telemetrySummary()` 单测覆盖 `cacheHitRate`、`p50/p95`、剥离 `human_wait` 后的纯执行耗时、`toolStats`、`skill_activated` 与 `qualitySignals`；
  2. `/system` 完整呈现 7 日趋势、失败归因、空转告警、Cache 命中率与 `Tools` 性能表；`/system/runs/[runId]` 可展开多跳派发树、三色瀑布图、Tool I/O 与冻结 Prompt 快照。
- **Phase 2**：
  1. `<dataDir>/evals/*.eval.json` 读写带 Git commit 留痕且支持历史/回滚；
  2. 支持 `skill` / `workflow` / `agent` 三类评测集运行，覆盖 Layer 1–3 Grader、`pass@k` / `pass^k`、临时 worktree 自动回收、dry-run 拦截、预算熔断与仅重跑失败 Case；
  3. 评测 Run 默认不污染 `/system` 生产大盘与人类会话/飞书通知；Web `/system/evals` 支持 Baseline vs Candidate A/B Diff 并直达任意 Case 的 Run Trace。
- **Phase 3**：
  1. 支持对任意 Run / Workflow 执行打标 👍/👎 并一键沉淀为 `<dataDir>/evals/*.eval.json` 中的新 Case；
  2. Workflow 详情页与 Skill 页可见关联评测集状态并一键触发回归。
- **全仓门禁**：各阶段完成后 `typecheck` / `lint` / `test` / `audit` 全绿。
