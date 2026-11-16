# ADR 0053: 长会话的状态保留 —— 压缩分段 + 事实台账

- 状态: Implemented
- 日期: 2026-11-16
- 相关: ADR 0017（canonical messages）、ADR 0020（CLI session continuation）、ADR 0051（授权链）、`docs/notes/intent-and-attention-research.md`

## 0. 先纠正一个前提

写方案时查了执行链，发现**我们打算改的那一层几乎不生效**：

- ACP 轨每轮 `session/load` 重放，**历史住在子进程的会话文件里**；
- 后端的 branch projection 只在"没有 cliSessionRef"的 bridge 场景才被渲染进 prompt（`execution-input.ts:110`：`const bridge = !cliSessionRef && history.length > 0 ? … : ""`）；
- 因此后端的 `POST /api/conversations/:id/compact`（写 `ProductSummaryEntry`）对 ACP 会话**基本不参与**——它写出的摘要没有读者。

真正决定"长会话忘不忘"的，是 **oma 子进程里的 `compactSession`**（`apps/oh-my-agent/src/core/runtime/compaction.ts`）。

**所以本方案改的是 oma 的压缩；后端那条只补文档，不在这刀里接线。**

## 1. 现状（读代码得出，不是印象）

| 项 | 现状 |
|---|---|
| 触发 | token 预算（`triggerRatio`），切点落在完整工具对边界（`adjustCutForToolPairs`） |
| 摘要 | **一段散文**：`SUMMARIZATION_SYSTEM_PROMPT` 明确写 "No preamble, **no headings**, no code fences" |
| 二次压缩 | `UPDATE_TASK` 合并上一份摘要，要求"写成一份独立摘要，别提是更新" |
| 条目形状 | `CompactionEntry { entryId, summary, coversEntryIds, retainedEntryIds, tokensBefore }` |
| 工具输出 | 压缩前另有一层 `pruneOldToolResults`（只剪旧工具结果） |
| 问答 | `ask_question` 的 tool_use / tool_result 只是普通消息，压缩后并入散文 → **会丢** |

对照 omp 的实现（`@oh-my-pi/pi-agent-core/src/compaction/`）：它用**七段固定结构** + 一条硬规则"结尾的未答请求必须原样保留" + `details: { readFiles, modifiedFiles }` 的机读台账。

## 2. 决策

### D1 摘要改为固定分段

六段，段落名固定（模型输出必须使用）：

```
## Goal
## Constraints & Preferences
## Progress      （### Done / ### In Progress / ### Blocked）
## Key Decisions
## Next Steps
## Critical Context
```

切在半回合时追加 `## Turn Context (split turn)`（沿用现有的单趟方案，不做 omp 的两趟）。

### D2 两条硬规则

1. **结尾的未回答请求必须原样保留**（问题文本逐字，含等用户确认的操作）。
2. **精确标识符必须保留**：文件路径、命令、错误串、分支/提交号。

二次压缩的 `UPDATE_TASK` 相应改为：保留全部旧段；`In Progress` 完成的移到 `Done`；**已答的问题从 `Critical Context` 里删掉**；仍有效的约束不得丢。

### D3 事实台账：确定性提取，不问模型

> **实现时改了一条**：不新增 `CompactionEntry.facts` 字段，改成**三个文本段**（`<files>` / `<commands>` / `<qa>`）附在摘要末尾。
> 理由：这些事实唯一的消费者是提示词本身，文本就是它的接口；结构化字段会与同一份内容的文本版重复，还要多一条注入路径和一次序列化兼容处理。仓库里 `<files>` 已经就是这么做的（`upsertStateBlocks` 剥掉模型自写的段再追加），顺着扩两个段即可。将来若账本要按事实查询，再把它提升成字段。

由**被覆盖的消息**里提取，不增加模型调用：

| 来源 | 提取 |
|---|---|
| 工具调用 `read` / `write` / `edit` / `apply_patch` | 文件路径 + 读/改 |
| 工具调用 `bash` | 命令原文（截断 200 字符） |
| `ask_question` 的调用 + 对应结果 | 问答对（问题取 `input.questions[].question`，答案取结果文本） |

**不做**模型抽取决策/约束——那部分留给摘要的散文（`## Key Decisions` / `## Constraints`）。

理由：文件与命令是**结构化的既有事实**，从工具参数里取是零风险；让模型再抽一遍只会引入解析失败。对齐编织论文的消融结论：实体保留是压缩质量的关键，而实体恰好是我们已经有的数据。

### D4 跨压缩继承

**实现比设计更省**：三个段都按**整个被覆盖前缀**扫描（覆盖范围本身是累积的），所以继承是免费的，不需要"旧 facts ∪ 新 facts"的合并逻辑，也不需要跨条目携带任何状态。

上限：文件 20、命令 15、问答 10，超出淘汰最旧。

不这样扫会把"十轮前改过的文件"在第二次压缩时抹掉——这正是长会话最常见的丢失点（有测试与变异验证盯着）。

### D5 事实出现在摘要里，不需要单独注入

原来打算在重建时插一条 internal 消息。实现上不必要：摘要本身就是重建时置顶的那条消息（`[Context summary: …]`），三个段跟着它一起到模型面前。少一个注入点，就少一处"事实块与摘要谁是权威"的歧义——段就在摘要正文里，模型读到的是一份文档。

## 3. 数据形状

`CompactionEntry` 的形状**不变**（`summary` / `coversEntryIds` / `retainedEntryIds` / `tokensBefore`）——事实是摘要文本的一部分。会话存储无迁移，旧摘要照常可读（只是没有那两个新段）。

## 4. 变更清单

| 文件 | 改动 |
|---|---|
| `apps/oh-my-agent/src/core/runtime/compaction-prompt.ts` | 六段提示词、两条 MUST、`UPDATE_TASK` 合并规则 |
| `apps/oh-my-agent/src/core/runtime/compaction-prompt.ts` | 六段提示词 + 两条 MUST + `UPDATE_TASK` 合并规则；`collectCommands` / `renderCommands` / `collectQa` / `renderQa`；`upsertFileOperations` → `upsertStateBlocks`（剥三个段） |
| `apps/oh-my-agent/src/core/runtime/compaction.ts` | `compactSession` 拼三个段 |
| `apps/oh-my-agent/src/core/runtime/compaction-prompt.test.ts` 与 `compaction.test.ts` | 段落顺序、MUST 规则、命令去重/截断/上限、问答配对（含超时）、跨压缩继承 |
| `docs/architecture/runtime/compaction.md` | 六段与三个段落的说明；补上"后端 `/compact` 对 ACP 不生效" |
| `docs/adr/README.md` | 索引 |

后端 `ProductSummaryEntry` **本刀不动**（没有读者）。若将来把 ACP 的历史交还给后端投影，再复用同一个提取器。

## 5. 测试（已实现）

纯函数优先，模型不参与：

1. 提示词：六段顺序、`## Turn Context (split turn)`、`VERBATIM` 规则（断言文本，防止重构时被悄悄删掉）。
2. 命令：去重、单条截断、只留最近 15 条并标注丢弃数。
3. 问答：按 `tool_use_id` 配对、选项与自由文本都提取、超时记 `(no answer: ask timeout)`。
4. 端到端（`compactSession`）：三个段都写进摘要；**第二次压缩后第一次的命令仍在**（继承）。
5. upsert：模型自写的 `<files>`/`<commands>` 被剥掉，不叠加。

**变异验证（三条都已执行，各自变红）**：
- 删掉"未答请求必须保留" → 提示词断言红；
- 把段扫描从"整个被覆盖前缀"改成"仅新区间" → 继承测试红；
- 去掉 `<qa>` 段 → 端到端问答测试红。

## 6. 验收

单测覆盖了"两次压缩后第一次的命令/问答仍在"，以及段的上限与格式。真机 60 轮会话的端到端复测**未做**（需要长会话样本）；等有真实长会话时按同样断言复测。

## 7. 风险

| 风险 | 处置 |
|---|---|
| 段落越长越大 | 三段各有上限，超出写明丢弃了多少条 |
| 事实与摘要冲突 | 事实来自工具参数而非模型叙述；`upsertStateBlocks` 只认自己追加的那份 |
| 旧摘要没有新段 | 无需处理：段是文本，缺了就是缺了，不影响读取 |
| 提取把敏感路径写进上下文 | 路径本来就在对话里；不额外扩大暴露面 |

## 8. 不做

- **snapcompact**（把历史渲染成 PNG 让视觉模型读）——依赖读图能力与计价，收益不确定。
- **两趟拆分压缩**（omp 对半回合的做法）——保留现有单趟 + `Turn Context` 段。
- **按线程分段的摘要**——本地实测没有长会话负载（1403 会话、人均 1.1 条人话），现在做等于给零负载造机器。
- **后端压缩接线**——`/compact` 对 ACP 无效这件事，先用文档说清楚；要接线另开 ADR。
