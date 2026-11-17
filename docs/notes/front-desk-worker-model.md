# 前台 ↔ 工人：当前模型（2026-11-17，可评审稿）

本文件是**现状 + 已定决策**的快照，不是愿望清单。每条都能指到代码或 ADR。
未实现的部分单独一节，标注 Proposed。

---

## 0. 一句话

**人只对前台说话；前台只做四件事（理解、派单、等、改写）；执行是一次性子进程；
所有事实进同一本账；授权在派单前冻结；回传只有"必须有人动作"的两档。**

---

## 1. 分层总览

```
                    ┌──────────────────────────────────────────────────────┐
                    │                人（唯一授权源）                       │
                    │  飞书群/私聊 · Web 聊天 · GitHub webhook（未做）      │
                    └───────────────┬──────────────────────────────────────┘
                                    │ 人话
                                    ▼
   ┌───────────────────────────────────────────────────────────────────────┐
   │  表面层（只呈现与投递，不判断"该不该干"）                              │
   │    apps/lark-bot   AHP 订阅 + run 卡片 + 话题投递                     │
   │    apps/web        Next BFF + React Query（时间线、审批、账本）        │
   └───────────────┬───────────────────────────────────────────────────────┘
                   │ HTTP / SSE（Eden Treaty typed client）
                   ▼
   ┌───────────────────────────────────────────────────────────────────────┐
   │  后端 = 唯一事实源（apps/backend）                                     │
   │                                                                       │
   │  conversation_ledger     会话账本：人话 / agent 消息 / 通知（共享）    │
   │  conversation_member     房间成员：前台 + 工人                         │
   │  agent_context_branch    每 (conversation, agent) 一条分支             │
   │  agent_run               一次执行尝试：状态 / 终态 / 授权 / 父 run     │
   │  branch_input_queue      输入队列：pending · queued · steer            │
   │  product_tool_call       产品工具调用幂等记录（callId + inputHash）    │
   └───────────────┬───────────────────────────────────────────────────────┘
                   │ enqueueAndAcquire：同一事务里
                   │ 写输入行 + 抢分支（每分支一个活跃 run）+ 建 run
                   ▼
   ┌───────────────────────────────────────────────────────────────────────┐
   │  执行层：一次性子进程（ACP，每 run 一个）                              │
   │    oma 运行时：agent-loop + coordination registry + 工具/插件          │
   │    不变量：终态一次提交；崩溃/挂起可恢复（同 runId 换新进程，ADR 0038）│
   └───────────────────────────────────────────────────────────────────────┘
```

**上下文隔离（重要）：**

| 东西 | 范围 | 谁能看见 |
|---|---|---|
| 账本消息 | 会话 | 房间内所有人（前台 + 工人 + 人） |
| 模型上下文分支 | `(conversationId, agentId)` | 只有该 agent；每轮启动补最近 20 条共享账本消息 |
| 思考与工具调用 | 该 run | 只有该 run 的模型上下文，**不进账本、别人看不到** |
| workspace | agent 级（或 pinned） | 共享 checkout 在 run 全生命周期内串行（ADR 0023 §5） |
| run 卡片（飞书） | 每个 run | 目前**所有人可见**（已知归属问题，见 §7） |

---

## 2. 一条人话的完整路径

```
人: "登录一直转圈，修一下"
 │
 │ ① postMessage（前台不变量 ADR 0049：人工输入落前台分支；
 │   点名 worker 会被改写回前台，原文保留在 @ 文本里）
 ▼
前台 run 起
 │
 │ ② 意图 = 四维 facet，不是枚举（ADR 0054）
 │      verb ∈ fix|build|review|investigate|write|operate|answer
 │      deliverable ∈ answer|change|report|state-change
 │      object（人话里的对象）+ reversibility
 │      必填槽位由 (verb, deliverable) 推导：fix → repro/expected/scope/acceptance
 │      缺槽位 → 派单前拒绝，一次列出全部缺口 → 问人（不派单）
 │      不可逆 operate → 派单 run 必须是 user 授权
 │
 │ ③ dispatch(instruction = 人的原话 + slots + note)
 │      enqueueAndAcquire 落房间账本
 │      authorization = dispatch:<前台agent>
 │      parent_run_id = <前台 run>
 ▼
worker run 起（一次性子进程）
 │
 │ ④ 执行：工具 / 审批 / 沙箱 / 写路径规则
 │      report(progress)  → 只落账，**永不唤醒**
 │      report(attention) → 唤醒前台（唯一必须打断人的 worker 事件）
 │      handback(reason)  → 退回：唤醒派单者，授权 handback:<worker>
 │
 │ ⑤ 终态（completed | failed | aborted | timeout）
 │      notify-dispatcher 选轨：
 │        · 前台有活跃 run → steer 注入（**不产生新 run**）
 │        · 前台空闲       → 排队输入 authorization=result:<worker>
 │        · 父链深度 ≥3    → 只落账（不唤醒，防自我驱动）
 ▼
前台 run 被唤醒/下一轮
 │
 │ ⑥ 读结果 + 验收证据 → 给人**重写一句**（禁止转发原文）
 ▼
人看到一条线性时间线
```

---

## 3. Run 状态机（含恢复与返工）

```
                  enqueueAndAcquire
                         │
                         ▼
        ┌──────────► running ◄───────────────┐
        │              │  │                 │
        │              │  └──► waiting ─────┘  resume（同 runId，新子进程）
        │              │        │  HITL 审批 / 追问挂起
        │              │        └──► running（人答完）
        │              │
        │   ┌──────────┴─────┬──────────┬─────────┐
        │   ▼                ▼          ▼         ▼
        │ completed        failed     aborted   timeout
        │  └──────── 终态一次提交（幂等：同结果重放，冲突结果拒绝）────────┘
        │
        └─ commit_failed（提交事务失败；保留 outcome，可 retryTerminalCommit）
```

**返工不回复边：**

```
Run A = completed（验收不达标）
   │  前台重新 dispatch（带上不满意的 acceptance 条目）
   ▼
Run B = 新 run（A 的终态、产物、工具调用全部保持原样）
```

`parent_run_id`（凭什么跑）与"替谁重做"是两个事实，前者已有列，后者**目前不建列**
（无消费者、派单零流量；见 §8 触发条件）。

---

## 4. 监督循环与双路唤醒

```
前台 run 的 oma 循环
  每一步结束：
    有 steer          → drain，继续
    有本地后台活      → hold：
                          任一 entry 终结 | 有 steer | 取消 | 切片超时(≤10s)
                          切片内每 100ms 轮询一次"有没有新输入"
                          · job 终结 → 结果作为 job_result 消息注入，继续
                          · steer    → 继续
                          · 8 次 park 用尽 → 注入"仍在运行"说明后收尾
    两者都没有        → 允许收尾
```

**收尾门槛有一个刻意的例外：远程工人的活不算"未收敛"。**

| 未收敛的活 | 处理 | 为什么可以收尾 |
|---|---|---|
| 本地后台作业（bash/eval/subagent） | hold | 随 run 生死，收尾即被杀 |
| 远程工人的 run | **允许收尾** | 终态会以 steer 或 `result:` 排队输入回来，下一轮接上 |

一次性子进程不能既收尾又保留上下文 —— 这是本模型与"run 常驻、不 final"方案的根本分歧点。

---

## 5. 授权模型

```
authorization（派单前冻结进 run 快照；HTTP 消息入口不接受该字段）
  user                 人直接发起（唯一来源：HTTP 消息面）
  ambient:<ruleId>     环境规则 act 命中
  dispatch:<agentId>   dispatch 产品工具
  handback:<agentId>   工人退回
  result:<agentId>     工人终态 / 上报把前台唤醒
  system               workflow / 提醒 / 恢复

parent_run_id 非空  ⇔  authorization ∈ {dispatch:, handback:, result:}
链深 ≥3 ⇒ 只落账（唤醒会再造第 4 层，机制不能自我驱动）
```

**能力边界分层（谁在哪一层被拦）：**

| 层 | 拦什么 | 现状 |
|---|---|---|
| 派单前（后端） | 缺料、不可逆无 user 授权、worker 不可直接建会话 | 已实现 |
| 工具层（子进程内） | 写路径 allow/deny、PROTECTED_FILES、密钥剥离 | 规则已实现，**注入链路未接** |
| 沙箱（bwrap） | 网络二值（全断/全开）、文件系统隔离 | 已实现；per-host 白名单需特权 |
| 协作式代理 | 只允许的 registry 主机 | 已实现，天花板：忽略代理变量的脚本直连 |

---

## 6. 事实层 vs 呈现层（防误认的三条）

```
事实（账本，不可编造）
  · 谁写的（senderMemberId）
  · 哪个 run 产生的（agentRunId）
  · 凭什么跑（authorization + parent_run_id）
  · 工具调用记录（product_tool_call，幂等）

呈现（表面层，必须遵守）
  · 人与模型看到的**没有**工具调用与思考（只在 Web 过程视图）
  · 工人在 Web 新建会话里不出现（ADR 0050：人够不着的地方不露出来）
  · 对人的一句话由前台重写；工人原话只在证据/过程里出现
```

---

## 7. 已知缺口（诚实清单）

1. **飞书里工人 run 的卡片没有署名** → 工人产出被读成前台说的（归属错误）。
   候选修法：工人 run 不发卡片（删掉这个面），或卡片标题带 agent。
2. **写路径规则的注入链路未接**：agent 配置 → run 快照 → 子进程 env（后端已有 per-run env 通道）。
3. **`report` 没有验收证据字段**：前台无法区分"验过了"与"没验"。
4. **前台没有 `steer_worker` / `cancel_worker`**：中途改主意 / 停跑飞的活只能等人插话。
5. **没有 per-worker 并发上限**：同一 worker 可在多个房间并行（靠 workspace 隔离，不靠槽位）。
6. **持久化不做**：job 随 run 生死；"合上电脑工作继续"需要另立 ADR。

---

## 8. 明确不做的层（附触发条件）

| 不做 | 理由 | 什么时候再考虑 |
|---|---|---|
| `Task` 聚合 + 状态机 + CAS 认领 | 本机 1600 个 run、0 次 dispatch；原子单位是 `(branch, input)` 的 acquire | 需要跨 run 维护目标状态且有真实派单流量时 |
| 话题栈 / active_topic_id | 1405 个会话中位 1 条人话、≥20 条 0 个、2.8% 落在 run 存活期 | 会话内并行多话题成为常态时 |
| per-worker `concurrency_slots` | 房间内靠分支串行、跨房间靠 workspace 隔离、共享 checkout 已串行 | 出现"同一 workspace 双写"的真实事故时 |
| `execution_epoch` | 终态提交已是 CAS（同结果幂等、冲突拒绝），双写者在这一步被拦 | 出现两个子进程同时产生有效写入的证据时 |
| 签名的 capability token | 单用户本机；token 拦不住 bash，真正的边界是沙箱 + 写路径规则 | 多租户 / 远程 worker 时 |
| `rework_of_run_id` 列 | 返工的语义已由"新 run + 终态不可变"保证，无消费者 | 需要审计面板显示"R2 替代 R1"时 |

---

## 9. 若要评审，请重点看这五处

1. **一次性子进程 + 远程活允许收尾**：会不会出现"前台收尾了，工人还在跑，人以为结束了"？我们的答案：终态必回传（双路），但回传失败时人确实无从知晓 —— 这算不算漏洞？
2. **分支级串行**是否足够：同一 worker 在 A 房间跑、B 房间也派给它，两个 run 并行、workspace 相同 —— 靠 agent 级 workspace 隔离够吗？
3. **授权链深度 ≥3 只落账**：拒绝唤醒意味着人可能永远不知道第 4 层发生了什么，这是有意取舍还是缺陷？
4. **验收不进状态机**：前台据 `verification` 决定措辞，但没有任何机制阻止它说"已完成" —— 靠提示词够不够？
5. **worker 卡片去留**：不发卡片（人看不到工人进度）vs 发卡片带署名（多一个面要维护），哪个更符合"人只需要一条线性时间线"？
