# 0048 语义研判与能力卡：主动脊柱第三刀

- 状态：Accepted
- 日期：2026-11-11
- 关联：0046（环境规则）、0047（房间派单）、0038（HITL）、0025（workflow 分类器教训）

## 背景

前两刀给主动性搭了确定性骨架：关键词规则（0046）与房间派单（0047）。规则做入口有天花板（漏报/误报/腐烂/盲区，见 0047 讨论），DeepSeek 原型的答案是**语义层**：规则退居语义提示，模型研判"该不该接"，observe 档默认只记 would-accept。本 ADR 落这一层，同时补上派单决策缺的输入——agent 能力卡（dsh 的 AgentCard、A2A v1.0 同款形状）。

## 决定

1. **能力卡进 agent 配置**：顶层 `skills: [{id, description}]`（缺省空），与 name/description 一起构成卡片。这是领班派单（dispatch 工具读团队名册）与语义研判（选目标 agent）的共同输入，形状对齐 A2A AgentCard 的 skills——将来联邦边界上直接序列化成真卡片，不改字段。
2. **新只读产品工具 `team_list`**：返回全部启用且未归档 agent 的 `{id, name, description, skills}`。领班的 run 靠它知道"手下有谁、各会什么"——这是 0047 派单一直缺的发现面。
3. **语义研判挂在观察缝的规则未命中分支上，异步执行**：
   - 闸门：settings KV `proactiveAssessment = {mode: "off"|"observe"|"auto", model: "<provider>/<model>"}`，缺省 off；逐条消息读取，改配置不重启。
   - **确定性规则永远是快路**：命中规则的走 0046/0047 原路径（同步升格）；只有未命中任何规则的消息才进研判。研判不得推翻 record 规则。
   - **POST 永不等待模型**：消息先按 observe 落账返回；研判在后台跑，promotion 是第二条消息（引用原文、任务框定、`addressedTo=[选中agent]`、授权依据 `ambient:assessment`、发送者沿用原发送者）。
   - observe 档：正向研判只落 would-accept 事件（`proactive_event`，mode=`assessment`）。auto 档：落事件 + 真派发（复用 0047 的成员加入与派单机器）。
   - **失败语义（0046 继承 + 0025 教训）**：模型错误 / JSON 解析失败 / 25 秒超时 → 落 error 事件 + 日志，绝不动原始消息、绝不死锁、绝不放行。研判器不可用 = 这条消息维持 observe，天塌不下来。
4. **事件台账扩两档**：`proactive_event.mode` 增加 `assessment`；`outcome` 增加 `error`（研判失败的可观测面——"为什么没触发"答得出来）。

## 不变量

1. 原始消息的 POST 延迟里没有任何模型调用。
2. 研判产出的派发与被点名/规则/工具派单走同一条 enqueueAndAcquire 链路，授权依据可查。
3. 研判不能自我授权：HTTP 面不收 authorization，promotion 一律 `ambient:assessment`。
4. 拒绝不记账（噪音控制）：只有 would-accept 与 error 落台账——群里每条闲聊都记一条 reject 是把账本变成垃圾场。

## A2A 语义对齐（记录，不改代码）

| A2A v1.0 | 我们 | 状态 |
|---|---|---|
| `INPUT_REQUIRED` 任务态 | `waiting` run + pending_action | 已同构 |
| `returnImmediately` + push notification | dispatch 返回 `{runId, queued}` + AHP 流 | 已同构 |
| Artifact | `artifacts://` 存储 | 已同构 |
| AgentCard.skills | agent 配置 `skills` | 本 ADR 落地 |
| wire（JSONRPC/gRPC/REST 绑定、发现端点、跨组织鉴权） | 无 | **联邦边界触发时再上**：第一个非本 backend 的 agent 出现时，直接 A2A v1.0，不自造 |

## 代价与边界

- 在途研判不持久：重启丢失正在评估的候选（dsh 持久化候选队列，我们记录为已知缺口；真需要时按 Effects 模式补）。
- 无批处理/去抖：dsh 按线程批评估；我们上游有 lark merge-hold，研判侧逐条（成本 = 每条未命中消息一次小模型调用，off 缺省 + observe 建议先行就是成本闸）。
- 同一事件在不同群各说一遍 = 各评估各派发（跨会话去重未做）。
- 研判质量取决于能力卡质量：卡是空的就别怪派错人。
