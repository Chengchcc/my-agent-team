# 0046 环境规则：super-agent 的主动脊柱

- 状态：Accepted
- 日期：2026-11-10
- 关联：0034（访问分层）、0037（话题=会话）、0041（成员路由）、0045（波次并行）

## 背景

DeepSeek Harness 的《Super-agent 设计探索》（2026-10-31）提出常驻、主动、并行的 agent 架构。对照本仓库盘点，四个支柱里三个已经在：

| Super-agent 概念 | 本仓库对应 | 状态 |
|---|---|---|
| Worker（每任务独立 session/目录，并行） | Agent Run + 一次性 ACP 子进程 + workspace lock + 崩溃恢复 | 已有 |
| Router（准入、分流、只处理被指派的工作） | lark 三层准入（ADR 0034）+ 成员路由（ADR 0041） | 已有（不叫 Router） |
| 注意力纪律（该说话才说话、一次一个问题） | ask_question / 审批卡 / pending-actions 全局读模型 | 已有 |
| **主动规则（"没被点名，但团队写过的规则允许它动"）** | **无** | **本 ADR** |

关键事实：群里**未被 @** 的消息今天并不是被丢掉——lark-bot 以 observe 结局把它 POST 进会话账本（`addressedTo: []`，只记上下文不触发 run）。也就是说「被动监听环境」这半个 super-agent 已经存在，缺的是另一半：**一条团队写的规则把某条观察升格为工作**。这正是 DeepSeek 的原话语义："acts only when asked, **or when a rule the team wrote allows it**"，以及 "proactive work starts in a mode that **only records what the agent would have done**"。

## 决定

1. **规则配置挂在 agent.yml 的 `lark.ambient.rules`**（操作者写、后端强制），每条规则：`id`、`chats`（空=所有被准入且被观察的群）、`senders`（open_id，空=任何已准入发送者）、`keyword`（对消息文本的**大小写不敏感子串**匹配）、`mode: "record" | "act"`、`instruction`（act 必填，是给 agent 的任务框定）。不做正则：写错的正则会静默匹配不到或匹配过宽，子串可预测。
2. **评估发生在 observe 缝上**：`postMessage` 在路由解析后 targets 为空、消息带 lark source、会话单成员、content 是纯文本时，调用注入的评估器。命中 record 规则 → 只落一条 `proactive_event`（"本可以做什么"的台账）；命中 act 规则 → 同样先落事件，再把消息**改写为规则框定的任务**（instruction + 原文引用）并按被点名处理——后续入队、run、卡片、审批、回复全部复用现有机器，零新增执行路径。
3. **record 是安全起点**：新规则的默认心智是先 record 观察命中情况，确认"它本来会做什么"之后再翻成 act。评估器落事件失败时按"未命中"处理（宁可不动作，不无台账地动作）。
4. **消息来源经 wire 传递**：lark-bot POST 消息时带 `source: { kind: "lark", chatId }`，后端据此做 chat 级 scoping；bot 自身不评估规则（规则的唯一真相源在后端）。

## 不变量

- 规则评估只发生在**自然路由为空**的输入上（observe）；被点名/单聊的既有触发路径一个字节都不变。
- act 触发的 run 与被点名的 run 走**同一条** enqueueAndAcquire / 卡片 / 审批链路；不引入第二条执行身份。
- 每次规则命中（record 或 act）必有一条 `proactive_event` 行；act 不落事件 = 不触发。
- 规则存 agent.yml（与 allowed_senders 同信任模型：单用户部署、操作者拥有工作区；需要防 agent 自改时用 `deny_write_paths` 盖住 agent.yml）。

## 代价与边界

- **多成员会话不评估**（成员数 >1 的 room 里未点名消息不参与规则）——room 的路由语义是显式点名，环境规则先不动它；有真实需求再议。
- **只匹配纯文本消息**；带图片的 ContentBlock[] 输入不参与（子串匹配没有对象）。lark 私聊永不 observe（ADR 0034），所以环境规则实际只在群里生效。
- 子串匹配是刻意的低配：语义分类（"这是不是给我的活"）留给后续的模型辅助评估，且必须继承"分类器不可用 → 退回 record"的失败语义（workflow 节点钉 yolo 的同款教训：无人值守路径上的分类器坏了不能死锁）。
- 主动规则目前的唯一来源是 lark observe；GitHub webhook 等新来源需要公网端点，进 roadmap 而不是本 ADR。
