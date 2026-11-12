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

取 Run 事务里随快照冻结；排队的输入把值带在队列行上，晋升成新 Run 时原样继承（变异验证钉住）。HTTP 消息入口**不接受**该字段——外部文本不能给自己授权。读模型：`GET /api/agent-runs/:id` 的 `authorization`。

## 环境规则指派目标

`lark.ambient.rules[].agent`（可选）：命中 act 规则且指定了别的 agent 时，先经共享的 conversationMembers 让目标入房间，再升格给它；目标加入失败（不存在/归档）则**整个升格取消**，消息维持 observe——宁可不动作。

## 不变量

1. 派单与自然点名走同一条 enqueueAndAcquire 链路，无第二执行身份。
2. 派单消息作者是领班成员，落共享账本，Web 时间线可见可审计。
3. authorization 只能由服务端设置；每个 run 答得出「凭什么跑」。
4. 房间加入第二位成员后未点名消息不再触发任何人（ADR 0041 派生语义，领班房间天然安静）。

## 已知边界

- 无工人槽位调度：派单点名具体 agent，空闲与否由领班（或规则作者）判断。
- 无回交（handback）通道：工人收到超范围请求按普通成员消息处理。
- 领班的「饥饿型」配置（少工具、短产出）是配置实践，不是代码约束。
- 观察缝的模型研判（该不该接、给谁）在 roadmap，失败语义必须退回 record。


## 前台不变量（ADR 0049）

agent 配置可声明 `role: "worker"`（缺省 = 前台语义）。此后：

- **人工输入**（授权依据恒为 `user`——HTTP 消息面是唯一来源）点名 worker 成员时，触发目标在 postMessage 里改写为会话前台（`conversation.agentId`）；@ 文本原样保留，前台看得到人本来想让谁做，可据此 dispatch。
- **产品派发**（`dispatch:` / `ambient:` / `system` 依据）不受影响——那是领班工具、环境规则、语义研判、workflow 在派活，本来就该直达工人。
- `POST /api/conversations` 绑 worker 直接 400（worker 拥有的会话是死房间：人工输入全被重路由回 worker 自己）。

不变量：worker 的 run 授权依据永远不可能是 `user`。