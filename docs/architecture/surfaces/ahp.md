---
title: AHP host
description: 端与后端之间那份契约的当前形态：通道与鉴权、快照与动作两条边各承载什么、产品事实怎么借 `_meta` 过到端上、寻址用哪个字段，以及还没接上的部分
tags: [surfaces, ahp, protocol]
---

# AHP host

一句话：端读 AHP，不再读自研事件流。后端是宿主（host），端是客户端，宿主握着状态，端把它铺开。

这一侧的名字跟协议走：上游把这侧叫 host，代码里是 `createAhpHost`，本页写「宿主」。另一侧是端（surface），指 Web、飞书这类客户端。

## 范围

覆盖：通道与鉴权、快照与动作两条边各承载什么、产品事实如何随 `_meta` 过到端上、寻址用哪个字段、端不许做什么。

不覆盖：协议自身的形状（见 [ADR 0040](../../adr/0040-run-contract-acp-surface-contract-ahp.md) 与上游规范）、各端内部渲染（见 [Web 端](./web.md)、[飞书](./lark.md)）、规范模型的派生规则（见 [Conversation History](../conversation/history.md)）。

## 实现文件

- `apps/backend/src/features/ahp/protocol.ts` — 协议机械：握手、订阅、重连、派发、错误码、回放缓冲
- `apps/backend/src/features/ahp/http.ts` — 宿主：`/ws/ahp` 挂载与取票端点
- `apps/backend/src/features/ahp/state-source.ts` — 只读投影，快照那条边
- `apps/backend/src/features/ahp/run-events.ts` — 运行期事件翻成 chat 动作，动作那条边
- `apps/backend/src/features/ahp/conformance/` — 上游 v0.9.0 的 218 条一致性向量
- `packages/ahp-client/src/transport.ts`、`uris.ts` — 共享传输与 URI 规则
- `apps/web/src/lib/ahp.ts`、`apps/web/src/lib/chat-state.ts` — Web 侧连接，以及状态到列表的映射
- `apps/lark-bot/src/ahp-delivery.ts` — 飞书侧的投递判定

## 通道与鉴权

三个频道：root（`ahp-root://`，agent 目录）、session（`ahp-session:/<conversationId>`，agent 加工作区）、chat（`ahp-chat:/<conversationId>`，会话本身）。对话端订 chat，需要 agent 目录时再订 root。

会话那份状态里 `workingDirectories` 给出这次会话的工作区（产品侧按 Agent 的工作区、项目 worktree、兜底根依次解析，与 Run 派发用的是同一条规则）。解析不出来时这个键缺席而不是让整份快照失败——项目没挂到 Agent 上在 Run 派发那侧是硬失败，在会话状态这侧只是「没有可展示的目录」。

鉴权在 upgrade 那一步完成。端先 `POST /api/ahp/ws-ticket` 取一次性票据，再连 `/ws/ahp?ticket=…`；票据只消费一次，无效票据以 4001 关闭。浏览器没法在 WebSocket 握手上带自定义头，所以票由 BFF 转发，URI 规则收在 `packages/ahp-client`，省得两端各写一份。

## 两条边

快照是「已经在那儿的」：订阅时宿主按规范模型现算一份状态，里面有历史轮次与片段、工具调用、审批与询问卡片、todo、续接提示。端的列表以它为准。

动作是「正在发生的」：文本与思考的增量、工具调用的开始与完成、轮次的开与合。动作按 id 落到同一份状态上，片段 id 与投影同一套规则，于是直播出来的片段和提交后投影出来的片段在端上是同一个对象。

顺序由宿主给，端不排序。协议里的 `Turn` 没有每轮的坐标，reducer 按宿主送达顺序把轮次推进 `turns[]`，宿主怎么排端就怎么铺。现在轮次之间按 run 的创建时刻排，轮次内部按账本行的 `message_index` 排。

## `_meta` 里承载的产品事实

协议为内存里的宿主会话设计，我们没有对应字段的位置就借 `_meta`，那是上游给宿主事实留的口子。端读这几个键：

| 键 | 挂在哪 | 含义 |
|---|---|---|
| `messageId` | 片段、轮次的起始消息 | 账本行的身份，端拿它把本地乐观回显与账本回显合成一条 |
| `seq` | 同上 | 账本坐标，寻址用 |
| `undone` | 同上 | 该行已撤销，端置灰 |
| `productRequest` | inputRequest 片段 | 审批或询问的原始载荷，卡片要显示批的是什么 |
| `productResponse` | inputRequest 片段 | 人的答复 |
| `todos` | chat 状态 | 活跃轮次的 todo 快照 |
| `newConversationId`、`requestedByRunId` | 续接提示轮次 | 续到了哪条会话，由哪个 Run 请求 |

这张表是约定，不是全部都有类型保护：协议给多数形状留了 `_meta?: Record<string, unknown>`，但没有给 `ChatInputRequest` 留，那里我们按同一套约定挂 `productRequest`（写入侧靠对象展开带上，编译器查不到）。改这些键名的时候，得同时改投影、动作写入方和两端读它的地方。

## 寻址用账本坐标

端上要指到某一行的动作有两个：从某条消息分叉、改完重发。它们把 `_meta.seq` 当坐标发给 REST，也就是 `/api/conversations/:id/fork` 与 `/replay` 的 `fromSeq`；撤销不指行，按条数发 `count`，返回被标记的行号。

`seq` 只在对话内解释，撤销是给行打软删标记，行号不重排，所以撤销之后同一个坐标仍指向同一行。端不许自己编坐标：坐标缺失时把那个动作关掉，拿 0 顶上会让分叉静默落到会话第一行。

## 不变量

- 账本加 Run 状态是唯一权威。宿主只有只读投影与命令端口两条路，自己不写账本。
- 轮次先于片段。片段动作按轮次 id 落在活跃轮次上，没有这个轮次就是空操作，所以宿主先开轮再发片段。
- 提交后由投影说话。Run 落盘时宿主把该轮按投影重述一遍（`chat/turnStarted` 整轮替换），再折进历史，直播里那些没有账本坐标的片段就此换掉，端拿到的是和新订阅者一模一样的状态。
- 命令端口接上控制面之前明确拒绝，端不能借它绕开 REST。

## 已知缺口

- 人工输入两侧现在都走动作：请求到达时发 `inputRequest` 片段（id 与投影一致，一问一次），人答复或被期限拒绝时发 `chat/inputCompleted`，卡片当场从「待答复」变掉。
- 询问的**答复内容**分成两半到端上：动作那条边只带结果（`accept`），内容随投影走。投影现在填两处：上游的 `answers`（按问题 id 的 `ChatInputAnswer`，形状已对着协议 0.9.0 的类型核实：`{state, value: {kind: text | selected | selected-many}}`，选择的与手输入的各是一种 kind，两者都有时用 selected-many 并把自由文本放进 `freeformValues`）以及产品自己的 `{id, selectedValues, freeText}` 行（挂在 `_meta.productResponse`）。**端的收尾还没做**：网页与飞书卡片仍只读 `productResponse`，两处改读 `answers` 之后才能把它从投影里删掉；在那之前两处并存，第三方端已经能只按上游读到答复。
- todo 只在 chat 状态的 `_meta.todos` 里，也就是只在快照里。协议没有任何动作能改 chat 的 `_meta`，所以「直播刷新 todo」要么等上游给出动作，要么由我们自定义一个动作、两端各自解释，要么退回重订阅。这条是待决策项。
- 续接提示写完就派发（`announceContinuity`）。代价：端如果在记录写入与派发之间订阅，它会从快照拿到这一轮、又收到这次派发，客户端状态里于是有同一轮的第二份副本；两端的渲染与投递都按 id 合并，所以看不出来。要消掉它，得让派发只发给「订阅早于这次写入」的连接。
- `apps/web/src/lib/chat-state.ts` 在坐标缺失时用 `seq: 0` 兜底，等于编一个坐标，要按上面那条改成关掉那个动作。
- Web 与飞书都还订着 Run 流（流规则提示、工作流进度、飞书的跑动卡）。旧事件词汇与 SSE 端点的删除还没做，清单在 [ADR 0040](../../adr/0040-run-contract-acp-surface-contract-ahp.md)。

## 相关页

- [ADR 0040 运行契约归 ACP，surface 契约归 AHP](../../adr/0040-run-contract-acp-surface-contract-ahp.md)
- [端总览](./overview.md)
- [Web 端](./web.md)
- [飞书](./lark.md)
- [标识符与幂等键](../foundations/identifiers.md)
- [Conversation History](../conversation/history.md)
