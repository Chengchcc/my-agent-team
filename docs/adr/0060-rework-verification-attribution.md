# ADR 0060: 返工、验收与署名 —— 派单契约的返回半张

- 状态: Proposed
- 日期: 2026-11-17
- 相关: ADR 0052（池化与回交）、ADR 0054（意图四维 facet）、ADR 0059（双路回填）、ADR 0051（授权链）

## 背景

ADR 0059 第 2 刀把"工人终态回到派单者"接通了，但回传的是一条自由文本。于是前台收到"干完了"却无法判断能不能直接交代给人——`acceptance` 只在派单侧是必填槽位，**回传侧没有兑现面**，等于写了半个契约。

同时，一轮与外部 agent 的协议对谈（前台↔worker 契约、意图识别、话题切换、结果回传）给出了另一套模型。本 ADR 记录我们对它的取舍：采纳三处，拒绝三处，并钉住两边都不成立的说法。

本机实测（`apps/backend/.backend-data/backend.db`，数据截至 2026-11-11、派单功能上线前）：1405 个有人类消息的会话、1559 条人类消息，**人均中位 1 条、最大 18、≥20 条 0 个**；落在某个 run 存活期内的人类消息 **44 条（2.8%）**；1600 个 run 中 **0 条 dispatch、0 条 parent_run_id**。⇒ 派单本身还没有可观察的流量，任何契约字段必须由机制自身产生，而不是靠设想。

## 决策

### D1 验收分三类，前台不做语义验收

| 类别 | 判定者 | 依据 |
|---|---|---|
| 可执行验收 | worker 执行器 / 自动化检查 | test、lint、build、diff、文件存在性 |
| 策略验收 | 服务端（授权、scope、危险动作、必需工件） | 派单侧已有（ADR 0054 的 `needsHumanAuthority`） |
| 主观验收 | 人 | "是否符合预期" |

前台只做四件事：收到 `done`、读已记录的检查结果、组织成人能读的摘要、标注"等待人验收"或"自动验收已通过"。**它不凭"读起来不太像"退回任何东西。**

`report` 的终态档扩展为结构化信封：

```
Completion {
  deliverables[]        PR/文件/报告链接
  checks[] { id, commandOrEvaluator, result: pass|fail|skipped, evidence }
  acceptance[] { item, selfVerdict, evidence }   // 逐条自评，不是"我干完了"
  decisions[]           open_questions 里自行决定了什么、为什么
  risks[]               未解决的风险
  verification          auto_passed | auto_failed | not_automatically_verifiable
}
```

`checks[]` 为空时 `verification = not_automatically_verifiable` 是**必须显式写出的诚实话**，而不是把 worker 自评伪装成验收通过。

### D2 返工 = 新 run，不建 Task 聚合

- **终态一次提交**保证一个 run 的产物不可变；返工**新建 run**，`rework_of_run_id` 指向被返工的 run。
- `parent_run_id`（授权链）与 `rework_of_run_id`（返工关系）是两个事实，不可混用：前者答"凭什么跑"，后者答"这条新尝试在替谁重做"。
- **不建 Task 实体**：派单零流量，把 `task_id + status 机 + 认领` 建成聚合是给预期造机器。两列表足够可追溯。

### D3 署名与路由分离

账本里 `senderMemberId` 已经是事实，Web 时间线按它署名。缺的是**投递侧**：飞书里工人的话由前台的 bot 投递，人看到的是"前台说的"——**能力边界与责任被误认**。

- 事件保留原文与来源（runId + agentId），作为证据；
- 对人的消息必须是前台组织的摘要，且**标注来源**（`执行单元 <agentId> …`，或卡片字段），不得以第一人称冒充工人；
- 未来若工人拥有独立可见身份，可直接以其身份投递，但不得伪造。

### D4 明确不做

| 不做 | 理由 |
|---|---|
| `Task` 聚合 / 状态机 / CAS 认领 | 零派单流量；我们的原子单位是 `(branch, input)` 的 acquire，DB 保证每 branch 一个活跃 run |
| per-worker `concurrency_slots` | 房间内靠 branch 串行、跨房间靠 workspace 隔离；共享 checkout 已由 ADR 0023 §5 在 run 全生命周期内串行，槽位是第三道没人要求过的闸 |
| `progress` 阈值与自动转发 | 无数据可定阈值；ADR 0059 已定 progress 只落账、永不唤醒 |
| capability token 签名 | 单用户本机；且 token 拦不住 bash —— 真正的边界是 sandbox 与写入路径规则（allow-rules 注入链路仍是待办） |

### D5 `can_finalize` 与 ADR 0059 的收尾门槛是两件事

对方主张 `can_finalize(run) = 子任务终态 ∧ 无挂起命令 ∧ 无待决人输入 ∧ 完成事件已提交`。我们只实现前两条中的"无挂起命令"（hold），因为**远程工人不在我们的收尾门槛里**：

| 未收敛的活 | 我们的处理 | 为什么可以收尾 |
|---|---|---|
| 本地后台作业（bash/eval/subagent） | hold，作业终结注入 `job_result` 再继续 | 它随 run 生死，收尾即被杀 |
| 远程工人的 run | **允许收尾** | 终态会以 steer 或 `result:` 排队输入回来，下一轮接上（ADR 0059 D5） |

这是两条自洽的路：对方靠"run 不 final"，我们靠"下一轮"。谁对取决于进程模型——一次性子进程不能既收尾又保留上下文。

## 不变量

1. **终态不可变**（不是 run 不可变）：同一 run 可被恢复（`resumeParkedRun` 换子进程续跑），但 `terminal_result` 只写一次。
2. **验收结论只有三种**，不允许"看起来像完成了"。
3. **返工新 run**：`rework_of_run_id` 与 `parent_run_id` 分列，一个 run 最多一个 rework_of。
4. **投递可换、署名不可换**：消息由谁的 bot 发出是传输事实，谁写的、谁干的是事实事实。

## 落点

| 层 | 文件 |
|---|---|
| 工具 | `apps/backend/src/features/product-tools/{manifest,dispatch,service}.ts`（`report` 终态档改结构化） |
| 回填 | `apps/backend/src/features/agent-run/notify-dispatcher.ts`（终态通知携带 verification 结论） |
| 数据 | `apps/backend/src/infra/db/schema.ts`（`agent_run.rework_of_run_id`）+ 迁移 |
| 表面 | Web 时间线（已有署名，补 verification 角标）、`apps/lark-bot`（来源标注） |
| 提示词 | 前台纪律追加一条：`not_automatically_verifiable` 时不得说"已完成"

## 验收

1. `report` 终态档缺 `checks[]` → 回传里显式 `verification: not_automatically_verifiable`（不许省）；
2. 返工 run 的 `rework_of_run_id` 指向被返工 run，`parent_run_id` 仍指向派单方，两条测试各钉一次；
3. 飞书投递的工人来源被标注（或明确"前台摘要"），不得出现工人原话被当作前台第一人称；
4. 前台提示词：`auto_failed` / `not_automatically_verifiable` 两种情形下，回复不得出现"已完成"。
