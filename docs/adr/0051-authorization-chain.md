# ADR 0051: 授权链 —— run 的 parent_run_id

- 状态: Accepted
- 日期: 2026-11-16
- 相关: ADR 0047（房间派单）、ADR 0048（语义研判）、ADR 0049（前台不变量）

## 背景

ADR 0047 给每个 Run 冻了一个 `authorization` 字段，取值有穷：

```
user | ambient:<ruleId> | ambient:assessment | dispatch:<fromAgentId> | system
```

它回答"**这次执行是谁直接允许的**"。这个"直接"就是缺口。

真实的调用链经常是两跳甚至三跳：

```
人在会话里说「修一下登录」
  └─► 前台 Run          authorization = user
        └─► dispatch    ──► 工人 Run   authorization = dispatch:front
                                └─► dispatch ──► 又一个 Run  dispatch:worker
```

工人 Run 上只有 `dispatch:front`。**"因为某个真人要求"这个源头丢了。** 审计只能回答"前台派了它"，回答不了"这活儿最初是谁要的"——而这恰好是 ADR 0049「人看不到工人」必须配套的东西：看不见流程，至少要查得到来源。

## 决策

`agent_run` 与 `branch_input_queue` 各加一列 `parent_run_id text`。

**写入点是仅有的两个"派单制造 Run"的地方**，与 `authorization` 完全同构：

1. 派单工具调用（`product-tools/service.ts` 的 `dispatchWork`）把**调用方 Run 的 id** 传给 `deps.dispatch`；
2. 会话服务把它带进 `EnqueueCommand`；
3. 入队适配器写进队列快照，直接获取路径同时写进 Run；
4. 排队输入晋升成 Run 时，从快照原样复制。

其余四条通道（人、规则、研判、系统/定时）**不写**，保持 `NULL`。

## 强制不变量

> `authorization` 以 `dispatch:` 或 `handback:` 开头 **⇔** `parent_run_id` 非空。

派单是唯一会打上 `dispatch:` 标记的路径，回交（ADR 0052）是唯一打 `handback:` 的路径——两者都是链条的一跳。反之，任何父链非空的 run 必然由其中之一产生。这条是双侧的，测试可以断言任意一边。

## 为什么只存一跳

存一跳 + 逐跳回溯 = 完整链，且**每一跳都是当时的事实**。

替代方案是存一个反规范化的"根授权"（把顶层的 `user` 直接抄到工人身上）。否决理由：父 run 自己也可能有父，抄下来的值在链变长时会失真；而且它回答不了"中间经过谁"。链路是事实，聚合是查询时的事。

## 已知边界

- **不做通用因果图。** 消息 → Run 没有边；规则/研判产生的 run 的"源头"只能靠 `proactive_event`（`agentId + conversationId + ruleId`）反查，不精确到单条消息的 ledger seq。真需要时再加 `source_seq`，现在加是给一个没有消费方的列找理由。
- **不防环。** 派单链由 agent 之间的调用自然形成，运行时没有重入保护；一个自我派单的 agent 会撞上"单分支单活跃 run"的约束而排队，而不是无限递归。这条依赖既有约束，不新增机制。
- **不追溯历史行。** 迁移只加列，旧 run 保持 `NULL`（与 `authorization` 列同款约定）。

## 后果

- Run DTO 暴露 `parentRunId`，Web 的授权账本能画出"这件事最初是谁要的"。
- 派单测试断言 `parentRunId === 调用方 runId`；适配器测试断言它**跨排队晋升存活**（两次变异验证：分别打断直接获取与晋升写入，测试各自变红）。
