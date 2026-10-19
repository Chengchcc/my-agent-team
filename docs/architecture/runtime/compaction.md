---
title: Compaction
description: 四个触发入口、切点算法与 tool 配对回退、摘要写回与无进展守卫、上下文重建，以及与 pruning 和 CLI session 文件的关系
tags: [oma, runtime, context, models]
---

# Compaction

一句话：本页是 oma 内 compaction 的权威描述。它是子进程内的 Run 局部机制：按 token 预算把旧消息折成一条摘要条目，摘要置顶、原条目不删，所以上下文可以无损重建；子进程退出即消失，产品侧不参与。

## 范围

覆盖：触发集合、切点算法、tool 配对回退、摘要写回与无进展守卫、上下文重建、与 CLI session 文件的关系。

不覆盖：工具结果的按需修剪（见 [Oma Tools](./oma-tools.md) 的超时与预算一节）、产品侧的 run 状态（见 [Run 输出与实时更新](../runs/output-and-live-updates.md)）、oma 运行时总览（见 [Oma Runtime](./oma.md)）。

## 实现文件

- `apps/oh-my-agent/src/core/runtime/compaction.ts` — `findCut`、`adjustCutForToolPairs`、`latestCompaction`、`compactSession`
- `apps/oh-my-agent/src/core/runtime/compaction-prompt.ts` — 摘要请求的形状：`SUMMARIZATION_SYSTEM_PROMPT`、`serializeConversation`、`buildSummarizationRequest`
- `apps/oh-my-agent/src/core/runtime/context-estimate.ts` — token 估算、usage 锚定、静默溢出判据、以及触发储备量 `compactReserveTokens` / `triggerRatioFor`
- `apps/oh-my-agent/src/core/runtime/agent-loop-runner.ts` — 三个自动触发点与 `runCompactionRecovery`
- `apps/oh-my-agent/src/core/runtime/run-runtime.ts` — 摘要闭包与 `contextBudget`
- `apps/oh-my-agent/src/core/runtime/agent-loop-run.ts` — `readBranchMessages`，上下文重建
- `apps/oh-my-agent/src/core/store/session-tree.ts` — 条目类型（message / compaction）
- `apps/oh-my-agent/src/core/session/session-file.ts` — 摘要写进 CLI session 文件与 resume 时的折叠
- `apps/oh-my-agent/src/modes/tui/tui-commands-session.ts` — `/compact`

## 触发

四个入口，前三个自动、第四个手动，都汇到同一个 `compactSession`：

| 触发 | 条件 | 说明 |
|---|---|---|
| 阈值 | 活跃上下文估算超过 `limit × triggerRatio` | 估算只算**还活着**的条目（已被上次 compaction 覆盖的前缀不算），摘要本身也计 token |
| 静默溢出 | provider 收下了超长请求，靠 `usage` 与 `stopReason` 判定 | 同一个 turn 内压缩后重试该次模型调用 |
| provider 溢出错误 | `ProviderError.kind === "overflow"` | 同一个 turn 内压缩后重试一次 |
| 手动 | TUI 的 `/compact` | 另一份独立实现：TUI 自己发一段压缩提示词，不走 Run 的 `compact()` |

静默溢出与 provider 溢出错误共用一个一次性守卫 `overflowCompacted`：一个 Run 只消费一次。阈值触发的没有守卫，因为它随时可以再触发，安全性由下面的"无进展守卫"保证。

`limit` 是本次 Run 模型的 `contextWindow`。`triggerRatio` **不再硬编码**，而是由一个**储备量**推出来（`context-estimate.ts` 的 `triggerRatioFor`）：触发线 = `window − reserve`，`reserve = clamp(0.15 × window, 下限 16384, 上限 window/2)` —— 大窗按 15% 留、中窗按 16384 留、小到装不下下限的窗**最多让出一半**（这一条是相对 omp 的**有意偏离**：omp 在小窗退回 15% 比例，而它的窗口现实中都很大；oma 还要驱动小窗口的本地模型，而储备要覆盖「下一轮输出 + 它触发的工具结果」，这两样都不随窗口缩小；想回到比例语义就显式配 `compactReserveTokens`）。旋钮：工作区设置 `compactReserveTokens` 或环境变量 `OMA_COMPACT_RESERVE_TOKENS`（显式值被尊重，只要还给窗口留出空间）。恢复时压缩的目标是 `limit × min(1, triggerRatio)`——压到触发线而不是压到上限，否则刚压完就还在阈值之上，下一轮会再压一次、把上一轮刚保留的尾巴也吃掉。

## 切点算法

`findCut` 从**最旧的一端**开始累加 token，逐条扣除直到剩余量落在 limit 以内，得到切点；然后把切点钳到 `messages.length - 1`，**绝不吃掉最新一条消息**（否则极端情况下超大条目会把整段对话都覆盖掉，模型连摘要都看不到）。没有预算时退化成按条数切 `floor(len × 0.6)`。

随后只做一处修正：若切点正好落在一条 `tool` 角色的消息上（即切在 assistant 的 tool_use 与它的 tool_result 之间），把切点前移到那条 assistant 消息之前，让配对完整。除此之外没有别的筛选条件——不存在"只在 user 或 assistant 处切"这类规则，切点可以落在任何一条消息之前。

两条短路：消息总数少于 4 条时直接返回空结果；切点算下来不大于 0 时同样不动（上下文本来就没超）。

## 摘要与写回

`compactSession` 把被覆盖的消息（含 tool 块，工具语义要活着进摘要）交给 summarizer，然后向 store 追加一条：

```ts
{ type: "compaction", summary, coversEntryIds, tokensBefore?, retainedEntryIds?, createdAt }
```

摘要请求的形状固定在 `compaction-prompt.ts`（可脱离 store 与模型单测）：一条 system 提示（保留决策与理由、当前状态、确切标识符；用会话自己的语言写）+ 一条 user 消息，把转录包在 `<conversation>…</conversation>` 里。转录由 `serializeConversation` 渲染成角色标记的文本：`[user]` / `[assistant]` / `[tool]`，tool_use 渲染成 `[tool_use <name>] <input json>`，tool_result 渲染成 `[tool_result (error)] <content>`。**thinking 不渲染**（`ThinkingBlock` 自己的契约：reasoning 永不当会话文本 ✓）、**图片只留 `[image <mediaType>]` 标记**（不外泄 base64）。包一层 `<conversation>` 是为了让模型知道「这是要读的文档，不是要接着聊的对话」。两套任务提示都带一句 **split-turn 指引**：若转录结束在一轮对话中间，就自行收尾一个 `**Turn Context (split turn):**` 段（omp 为此额外跑第二次摘要再合并，见「已知缺口」）。

摘要**末尾会附一个 `<files>` 段**，由被覆盖区域的 tool 调用推导（`read` → `(Read)`、`write`/`edit` → `(Write)`、两者都碰 → `(RW)`）。它**不交给模型写**：取回摘要后由 `upsertFileOperations` 追加（同时剥掉模型自己写的 `<files>`，那只会是过时的）。清单按**整个被覆盖前缀**扫描（因此是累积的，但不需要在条目上携带任何细节），排序后最多 20 条，超出追加 `[…N files elided…]`。与 omp 的差异：**扁平列表**而非折叠目录树（20 条以内树只能省宽度，而下一轮要的是路径），也不记 `details.readFiles/modifiedFiles`。

原始 message 条目**不删**；`coversEntryIds` 是**累积**的（重建只认最新一条 compaction，所以覆盖一旦出现缺口，那些条目就会以原文回到模型面前）。

**从第二次起是「增量 + 更新」，不是重摘全前缀**：只把**上次覆盖点之后**的条目交给摘要（`coveredEntries` 减去上一版 `coveredIds`），上一版摘要的正文经 `opts.previousSummary` 单独送达，请求改用 `UPDATE_TASK`，并要求「写一份同时覆盖两者、但不提自己在更新的独立摘要」（对齐 omp 的 `compaction-update-summary.md` 形状）。于是摘要输入与成本随**新增工作量**增长，而不再随会话总长线性增长；被替换掉的旧区域由上一版摘要的正文继续承载。

两处守卫：

- 摘要期间被 abort → 不写任何条目。
- 无进展守卫：若这次要覆盖的条目全都已被更早的 compaction 覆盖过，立即返回空结果，不调 summarizer、不写条目。这是"按预算触发"能安全反复触发的原因——没有常驻的"已压缩过"标志（那种标志曾经试过，会从循环观测不到的状态里被重新武装，结果是主动压缩在 Run 剩下的时间里静默失效）。

summarizer 抛错不算 Run 失败：压缩是尽力而为的优化，失败只写调试日志，随后照常发模型请求。

## 上下文重建

`readBranchMessages` 取一支的条目，按最新一条 compaction 的 `coversEntryIds` 过滤掉被覆盖的条目，再把摘要作为一条 `[Context summary: …]` 的 user 消息置顶。摘要的置顶**不依赖是否还有消息存活**。

## 与 pruning 的关系

工具结果修剪（`prune`）是**独立的可选机制**，不是 compaction 的第一阶段：只有工作区配了 `prune` 才跑，且在同一个 turn 内先于阈值检查执行，能把旧 tool_result 截断到摘要形式（减少**发出去**的内容）。两者共用同一个 token 估算器，否则"省下的 token"与"预算减掉的 token"不可比。**注意（2026-10-13 核实）**：阈值检查实际读的是**分支里的原始条目**（`msgEntries` 用 `e.message` 估算），所以 prune 掉的内容**不会**拉低这次阈值判断——文档此前"省下来的量可能让这次压缩根本不必发生"的说法与实现不符；prune 的收益在「发出去的内容更少」，不在「更晚触发压缩」。

## 与 CLI session 文件的关系

Run 结束时把每条 compaction 追加进 CLI 自己的 session 文件，同时带一个 `replacesEarlierMessages` 标记：只有摘要描述的是该分支**全部**存活消息时它才为真，此时 resume 才会把摘要之前的消息折叠成一条 `<previous_session_summary>` 标记。用布尔而不是计数，是因为分支的覆盖范围与会话文件的消息事件是两套索引空间，计数会静默丢消息。

## 不变量

1. 原消息条目不删；覆盖范围记在 compaction 条目上，摘要只影响重建时的过滤。
2. 每次压缩绝不覆盖最新一条消息。
3. 一个 Run 最多消费一次溢出恢复；阈值触发可以多次，但无进展时不动手。
4. 摘要失败或中途被 abort 都不改变 Run 的终态。
5. 压缩是子进程内的行为，产品不参与也不需要知道。

## 已知缺口

- 估算器**已 CJK 感知**（`estimateTextTokens`：CJK 按 1.5 chars/token ✓，注释里写明为什么），且每次调用完成后用 provider 的 `usage` 给**当前上下文**定标（`usageAnchor` ✓）⇒ 偏差只落在「自锚点以来的增量」上。**残余偏差仍是 UNKNOWN，不是「已确认没有」** ✗：2026-10-13 两次真机测量（deepseek）都读错了用量字段（`actual=92`/`8`，明显是输出侧 ✓）⇒ 没拿到 prompt 大小 ✓。要定案只需先打印一次该 chunk 的 usage 形状（一次探针 ✓），再决定要不要按实测比率缩放每条消息的估算。
- 摘要**只能用本次 Run 自己的模型与凭证**：没有更便宜的专用摘要模型，也没有多候选重试（omp 两者都有），并共用模型调用同款的死线（默认 300s）。
- 序列化**不做长度截断**：一条超大 tool_result 会整条进摘要输入（omp 对 tool_result 做 head+tail 截断、对 tool_use 参数设单个与单次上限；等真实大工件把摘要撑爆再加，加的位置就是 `serializeConversation`）。
- `<files>` 只认 `read`/`write`/`edit` 三个工具（omp 同样只认这三个）：MCP 工具改的文件，或在 `bash` 里改的文件，都不会出现在清单里。
- split-turn 只是**提示词级**的：切点落在轮中间时，由同一份摘要自行收尾一个 `**Turn Context (split turn):**` 段。omp 则为轮前缀额外跑**第二次摘要**再合并 —— 两者覆盖同一批消息，差别只在呈现，所以这里省掉那次调用。代价是：提示词只是「要求」模型这么做，它可以不照做；omp 的两段是结构化保证的。
- 摘要**与主模型共用同一个模型与输出上限**（`maxTokens`）：2026-10-13 真机（deepseek）实测——把**模型自己的**输出上限压到 64 时，摘要调用被 thinking token 吃光预算、**返回空文本**。**代码救不了这一半**：逐调用的上限不可能越过模型声明的上限（`summaryMaxTokens` 只保证「够写摘要、且永不超过模型」）。已修的是**沉默那一半**：空摘要现在写成 `[empty summary: the model returned no text — check this model's output cap]`，让产物自己说明原因（运行仍然报成功，因为压缩本就是尽力而为）。
- 摘要转录有**两份实现**：后端的 `renderMessageForSummary`（已在 2026-10-13 修好工具块 ✓）与 oma 的 `serializeConversation`。出现第三个消费者时把两者提到 `@chengchenccc/message` 共用（那时再动包，现在只是一处小重复）。
- **（2026-10-13 已修，留作教训）** 压缩会改变**哪些 assistant 回合被重发**，而 deepseek 在 thinking 模式下硬性要求带上该回合的 `reasoning_content` —— 真机三次里两次 400。根因**不在压缩**，在**编码器**：`convertMessages` 静默丢弃了 `thinking` 块，请求方向从不发 `reasoning_content`（响应方向却会解析它）。已在编码器按 deepseek 方言补上并加测试。留这一条，是因为**是压缩把它暴露出来的**：任何「重放历史」的机制都会踩到同一类 provider 契约。

## 相关页

- [Oma Runtime](./oma.md) — per-Run 状态与 loop
- [Oma Tools](./oma-tools.md) — `prune` 旋钮与超时
- [Agent Context](../agents/context.md) — 产品侧的历史与投影
