---
title: 房间内派单（Room Dispatch）
description: agent 把活派给 agent：dispatch 产品工具、ADR 0041 房间成员化、Run 的授权依据
tags: [backend, agents, product-tools]
---

# 房间内派单（Room Dispatch）

本页是 ADR 0047 的权威描述：一个 agent 的 run 如何把一件活派给同会话的另一个 agent（领班/工人拓扑），以及每一次 Run 的「授权依据」记在哪。

## 范围

覆盖：`dispatch` 产品工具的契约与效果、房间成员化语义、`agent_run.authorization` 的取值与冻结、环境规则指派目标 agent、边界（没有调度、没有回交）。

不覆盖：环境规则本身（见 [环境规则](./ambient-rules.md)）、成员路由语义（ADR 0041）、HITL（ADR 0038）。

## 实现文件

- `apps/backend/src/features/product-tools/{dispatch,service,manifest}.ts` — `dispatch` 工具的 wire 定义、幂等 handler、`frameDispatchInput`
- `apps/backend/src/features/conversation/service.ts` — `postMessage` 的 `authorization` 参数；observe 缝的目标 agent 选择与成员加入
- `apps/backend/src/features/agent-run/{domain,service,adapter-sqlite-enqueue,adapter-sqlite-runs,adapter-sqlite-parse}.ts` — 授权依据的冻结、排队快照、晋升保真
- `apps/backend/src/bootstrap/features.ts` — 组装：共享的 conversationMembers、dispatch 闭包（成员加入 → 领班身份 postMessage）

## dispatch 工具

一次 run 内调 `dispatch { agent, instruction, note? }`：

1. 校验 `agent`/`instruction` 非空（note 可选）；
2. 幂等按既有 `(runId, callId)` 调用账——重放返回已存结果，同 callId 换输入是冲突；
3. bootstrap 闭包：目标 agent 加入会话成员（幂等；未知/归档 agent 抛错 → isError），再以**领班成员身份** postMessage（`senderMemberId = 领班`、`addressedTo = [工人]`、内容为 `frameDispatchInput`：instruction + 可选附注、`authorization = "dispatch:<领班id>"`）；
4. 返回 `{ agentId, runId, inputId, queued }`。

工具描述里钉了两条 prompt 契约（学 dsh 原型 `orchestrator_route`）：**instruction 必须携带请求者原话、不许转述成实现计划**；note 上限约 30 词、只装路由背景。

## 授权依据（廉价 Mandate）

`agent_run.authorization`（迁移 0059，同列也进了 `branch_input_queue` 的请求快照）：

| 值 | 谁写的 |
|---|---|
| `user` | 人的消息（默认） |
| `ambient:<ruleId>` | 环境规则 act 升格 |
| `dispatch:<fromAgentId>` | dispatch 产品工具 |
| `system` | workflow agent 节点、reminder |

取 Run 事务里随快照冻结；排队的输入把值带在队列行上，晋升成新 Run 时原样继承（变异验证钉住）。HTTP 消息入口**不接受**该字段——外部文本不能给自己授权。读模型：`GET /api/agent-runs/:id` 与列表的 `authorization`。

**派单的契约是维度，不是一句话（ADR 0054）**：`dispatch` 要求 `verb`（fix/build/review/investigate/write/operate/answer）+ `deliverable`（answer/change/report/state-change），再加可选的 `object`/`objectKind`/`references`/`reversibility`/`slots`。必需槽位由 `(verb, deliverable)` 推导（`product-tools/intent.ts` 的 `SLOTS_BY_VERB`）：`review` 只要求 target/criteria（没有 scope），`operate` 要求 environment/action/rollback。缺口不填就**在派单前**被拒，拒绝信息一次列出全部缺口；`verb=operate` 且不可逆时，跑这条派单的 run 必须是 `user` 授权（规则/研判只能去问人）。工人看到的消息由 `frameBrief` 生成：动作/交付/对象 → 槽位 → 可逆性 → 引用 → 请求者原文（逐字在最后）。

**池化与回交（ADR 0052）**：`dispatch` 的 `agent` 可省略——省略时 `pickAgent(capability?)` 从 `role: worker` 的启用 agent 里挑，排序为「活跃 run 少 → 最近启动早 → id 字典序」，`capability` 只做技能/描述的大小写不敏感子串过筛（刻意不接模型路由：派单在热路径上）。负载来自 `agentLoad()`（一次 GROUP BY，跨会话统计）。工人接到不属于自己的活时调 `handback({reason, suggestion?})`：仅 `dispatch:` 授权的 run 可用，以工人身份 @ 回 dispatcher、`authorization = handback:<workerId>`、`parent_run_id = 工人 run`，从而唤醒 dispatcher 并在账本留下退回事实；reason 必填，且不自动换人。

**工人终态与上报（ADR 0059 D5/D6）**：被 `dispatch:` 授权的 run 到终态时，后端从 `parent_run_id` 找回 dispatcher 并把结果送上去（`frameResultInput`：谁完成/失败 + 结果文字 + 「向人交代或继续处理」）。两条轨由「dispatcher 现在在做什么」决定：**有活跃 run → 以 steer 注入**（不产生新 run，循环的 hold 在一个切片内醒来）；**空闲 → 排队输入**，`authorization = result:<workerId>`、`parent_run_id = 工人 run`，人看到的是前台的下一轮而不是一个裸工人 run。工人也可以主动 `report({purpose, text})`：`progress` 只落账（**永不唤醒**——否则工人每几分钟打断一次前台），`attention`/`answer` 与终态同轨唤醒。护栏：父链深度 ≥ 3 时降级为只落账（唤醒会再造第 4 层，机制不能自己驱动自己）；`result:` 授权的 run 不再向自己的父通知（否则同一事实来回弹）；`handback:` run 由 tool 自身唤醒，终态不重复通知。终态通知在 `onRunCommitted`（completed）与 `onRunFailed`（failed/aborted/timeout）两处发出，模块是 `features/agent-run/notify-dispatcher.ts`。

`parent_run_id`（ADR 0051，迁移 0060）：派单链的上一跳——`dispatchWork` 把**调用方 Run 的 id** 传下来，同样随队列快照晋升存活。不变量双向成立：`authorization` 以 `dispatch:` 开头 ⇔ `parent_run_id` 非空，所以沿父链上溯不会走进死胡同。其余四条通道写 `NULL`。Web 的授权账本（`/system/authority`）靠它画"这件事最初是谁要的"。

## 环境规则指派目标

`lark.ambient.rules[].agent`（可选）：命中 act 规则且指定了别的 agent 时，先经共享的 conversationMembers 让目标入房间，再升格给它；目标加入失败（不存在/归档）则**整个升格取消**，消息维持 observe——宁可不动作。

## 不变量

1. 派单与自然点名走同一条 enqueueAndAcquire 链路，无第二执行身份。
2. 派单消息作者是领班成员，落共享账本，Web 时间线可见可审计。
3. authorization 只能由服务端设置；每个 run 答得出「凭什么跑」。
4. 房间加入第二位成员后未点名消息不再触发任何人（ADR 0041 派生语义，领班房间天然安静）。

## 已知边界

- 无工人槽位调度：派单点名具体 agent，空闲与否由领班（或规则作者）判断。
- 前台还没有 `wait_for`/`steer_worker`/`cancel_worker` 三个控制动词（ADR 0059 D6 剩余）：目前靠终态通知被动知晓，不能主动等/催/停。
- 领班的「饥饿型」配置（少工具、短产出）是配置实践，不是代码约束。
- 观察缝的模型研判（该不该接、给谁）在 roadmap，失败语义必须退回 record。


## 前台不变量（ADR 0049）

agent 配置可声明 `role: "worker"`（缺省 = 前台语义）。此后：

- **人工输入**（授权依据恒为 `user`——HTTP 消息面是唯一来源）点名 worker 成员时，触发目标在 postMessage 里改写为会话前台（`conversation.agentId`）；@ 文本原样保留，前台看得到人本来想让谁做，可据此 dispatch。
- **产品派发**（`dispatch:` / `ambient:` / `system` 依据）不受影响——那是领班工具、环境规则、语义研判、workflow 在派活，本来就该直达工人。
- `POST /api/conversations` 绑 worker 直接 400（worker 拥有的会话是死房间：人工输入全被重路由回 worker 自己）。

不变量：worker 的 run 授权依据永远不可能是 `user`。

补充（2026-11-13）：**worker 与 lark 互斥**——`role: worker` 且 `lark.enabled` 在 agentConfigSchema 层拒绝（API 建/改、agent.yml、启动三条路同一个 400/解析错）；已启用 lark 的 agent 翻成 worker 同样拒绝。工人从产品结构上就没有脸。