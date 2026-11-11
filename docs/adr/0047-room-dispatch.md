# 0047 房间内派单：领班/工人拓扑的第一刀

- 状态：Accepted
- 日期：2026-11-11
- 关联：0041（成员路由）、0046（环境规则）、0038（HITL 停靠）、0031/0032（卡片与投递）

## 背景

对照 DeepSeek Harness 的 super-agent 设计（Router/Worker 双层）做了完整差距盘点（ADR 0046 的映射表），结论：Worker（Run + 一次性子进程）与注意力纪律（HITL 卡）已有，缺的是** agent 把活派给 agent**的通道。本仓库的拓扑是多前台（每个 lark-enabled agent 一个 lark-bot），因此吸收的不是"全楼一个总台"，而是**每个前台背后可以坐一个领班，领班手下有一群工人**：

```
飞书 app A ─► lark-bot A ─► 会话（房间：A 是脸 + 成员）
                                │  A 的 run = 领班（评估、派单、回话）
                                │  派单 = 房间内点名工人
                 ┌──────────────┼──────────────┐
                 ▼              ▼              ▼
             worker A-1     worker A-2     （无 lark 的 agent）
```

关键现成件：ADR 0041 的多成员会话已经给了全部路由语义——工人是房间成员，派单就是一条 `addressedTo: [worker]` 的消息；工人的 run 跑在同一账本上，它的审批卡、提问卡、终态回复全部走既有机器浮到前台会话。**不需要任何新执行路径，也不需要 agent 间协议**（进程内命令 + 既有事件流，见 ADR 0046 的"持久性优先于双工"结论）。

## 决定

1. **`dispatch` 产品工具**：一次 run 内把一件活派给同会话的另一成员 agent。参数 `{agent, instruction, note?}`；效果 = 确保目标在房间成员里 → 以领班身份 postMessage（`addressedTo: [worker]`，内容为派单框定：instruction + 原文引用约束）→ 返回触发的 run。学 dsh 原型 `orchestrator_route` 的形状：**幂等靠既有的 (runId, callId) 调用账；instruction 要求携带请求者的原始话语，不转述**（写入工具描述，这是 prompt 契约不是协议约束）。
2. **Run 增加授权依据**（`agent_run.authorization`，迁移 0059）：`user`（人发的消息）/ `ambient:<ruleId>`（环境规则升格）/ `dispatch:<fromAgentId>`（领班派单）/ `system`（workflow、reminder 等系统作者）。在取 Run 事务里随快照冻结——这是 dsh 原型 Mandate 的廉价版：每一次 run 都答得出"凭什么跑"，排队晋升时跟着输入快照走，不丢。
3. **环境规则可指派目标 agent**：`lark.ambient.rules[].agent`（可选，默认会话原主人）。命中 act 规则且指定了别的 agent 时，先确保其成为房间成员再升格——规则就是手写的派单表（领班的确定性部分）。
4. **成员化的语义按 ADR 0041 原样生效**：房间一旦加入第二位成员，未点名消息不再触发任何人（mention-only）——领班房间的闲聊天然安静；工人的提问/审批卡在前台会话可答，不存在 workflow 隐藏会话那种"问人=死锁"的结构性风险。

## 不变量

- 派单与自然点名走**同一条** enqueueAndAcquire 链路；不引入第二个执行身份。
- 派单消息的作者是领班成员（senderMemberId = 领班 agent id），落在共享账本，Web 时间线可见、可审计。
- authorization 只能由服务端设置（产品工具内部调用带 `dispatch:`，观察缝带 `ambient:`），HTTP 消息入口不接受该字段——外部文本不能给自己授权。
- 目标 agent 不存在/已归档时：工具拒绝、规则升格降级为不升格（宁可不动作）。

## 代价与边界

- **领班的判断力是它自己 run 的判断力**：本刀不做模型路由（observe 缝的模型研判仍在 roadmap，失败语义必须退回 record）。领班要"饿"（工具少、产出短）是配置实践，不是本刀的代码。
- 工人槽位不调度：派单点名具体 agent，谁空闲谁合适由领班（或规则作者）判断；池化调度进 roadmap。
- 无回交（handback）通道：工人收到超范围请求时按普通成员消息处理（不触发或自己回答）；dsh 的 handback 语义等真实需求出现再议。
- 自派单（agent 派给自己）允许：语义就是给自己的排一个后续输入，无害且有用。
