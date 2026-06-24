---
id: runtime.context-manager
title: 上下文管理器
status: current
owners: architecture
last_verified_against_code: 2026-06-24
summary: "上下文管理器（ContextManager）是 runLoop 在每次调模型「之前」对消息历史做整形的那一道关口。它只有一个方法 shape：拿到完整线程消息，返回一份「这次该喂给模型」的消息。框架自带 5 种实现（透传、滑动窗口、token 预算、工具结果截断、摘要压缩），可用 pipeContextManagers 串联；但默认装的是透传，即「什么都不改」。它和插件的 beforeModel 钩子分工明确：先 shape 决定历史形状，再 beforeModel 注入记忆/技能。"
depends_on:
  - runtime.framework
used_by:
  - runtime.plugin
  - harness.harness
---

# 上下文管理器

上下文管理器（ContextManager）是 runLoop 在每次调模型「之前」对消息历史做整形的那一道关口。它只有一个方法 `shape`：拿到完整线程消息，返回一份「这次该喂给模型」的消息。框架自带 5 种实现，可用 `pipeContextManagers` 串联；但默认装的是透传，即「什么都不改」。

## 为什么需要这一层

模型的上下文窗口是有限的，而线程消息会随运行无限增长。总得有人决定：当历史太长时，砍掉哪些、保留哪些、要不要先压成摘要。把这个决定**单独抽成一道关口**，而不是散在循环里，好处是它可以被替换、被组合、被单独测试——循环本体只管「调用它」，不管它具体怎么裁。

它刻意只暴露一个方法：

```ts
interface ContextManager {
  shape(ctx: ContextManagerContext, messages: readonly Message[]): Message[] | Promise<Message[]>;
}
```

`messages` 是只读的完整线程历史，返回值是「本次模型调用应该看到的消息」。注意 `shape` **不持久修改线程**——它的产出只用于这一次模型调用，线程里的真实历史保持不变。这一点和[账本是唯一事实](../foundations/facts-and-projections.md)的原则一致：整形是投影式的临时变换，不是对事实的改写。

## 调用点：每次调模型之前

`shape` 在 runLoop 里的位置是固定的——`packages/framework/src/run-loop.ts`，模型调用前：

```ts
const shaped = await rt.contextManager.shape(
  { threadId, signal, logger, model },
  rt.thread.messages,
);
const finalMsgs = await rt.plugins.fireBeforeModel(shaped);
// ... model.stream(finalMsgs, ...)
```

顺序是关键：**先 `shape`，再 `beforeModel`**。上下文管理器先决定「历史保留成什么形状」，插件的 `beforeModel` 钩子再在这份形状之上注入临时内容（记忆、技能索引、系统提示）。两者职责不重叠：

- `shape` 管**历史的形状**——裁剪、压缩、截断既有消息，对象是「过去」。
- `beforeModel` 管**临时的注入**——把记忆/技能拼进去，对象是「这次额外要带的东西」。

```mermaid
flowchart LR
  T[thread.messages<br/>完整历史] --> S[contextManager.shape<br/>裁剪/压缩历史]
  S --> B[plugins.beforeModel<br/>注入记忆/技能]
  B --> M[model.stream]
```

### 当前局限：预算对注入是「瞎」的

这个顺序有一个现状缺陷需要明确：`shape` 的 token 预算只对它收到的 `thread.messages` 计数，**而真正发给模型的是 `beforeModel` 注入之后的 `finalMsgs`**（记忆快照、技能索引等都加在 `shape` 之后）。也就是说，即使 `summarizingContextManager` / `tokenBudgetContextManager` 把历史压到了预算线以内，紧随其后的注入又会把体积加回去——最终 payload 仍可能超出上下文窗口。整形器看不到它自己之后被塞进来的那部分，预算因此是不准的。这一缺陷的修复方向收拢在[未来工作](../roadmap/future-work.md)（M22）。

## 自带的 5 种实现

框架在 `packages/framework/src/context-managers/` 提供 5 种现成实现，各管一种「太长了怎么办」：

| 实现 | 策略 | 触发与产出 |
|------|------|-----------|
| `passthroughContextManager` | 透传 | 原样返回，什么都不改。**这是默认值。** |
| `slidingWindowContextManager` | 滑动窗口 | 按「轮次」保留最近 N 轮（`maxTurns`），可选保留最前 `keepFirst` 条；丢弃中间的旧轮次 |
| `tokenBudgetContextManager` | token 预算 | 从最新往回累加，直到逼近 `maxTokens - reserveForOutput`，砍掉装不下的旧消息 |
| `toolResultTruncator` | 工具结果截断 | 不删消息，只把超过 `maxCharsPerResult` 的 `tool_result` 内容尾部截短并标注截断量 |
| `summarizingContextManager` | 摘要压缩 | token 超过 `triggerAt` 时，把旧消息交给模型压成一条摘要，拼回最近 `keepRecent` 条之前 |

后三种都涉及「删/改消息」，因此都用 `repairToolPairs` 兜底：压缩或裁剪可能把一对 `tool_use` / `tool_result` 拆散在边界两侧，`repairToolPairs` 负责修复这种悬空配对，避免给模型喂出不合法的消息序列。

### 摘要是自由文本，不是结构化字段

`summarizingContextManager` 的默认摘要器（`defaultSummarize`）做的是：把旧消息追加一句「concisely summarize…」的指令丢给模型，取回纯文本，包成一条 `user` 消息——

```ts
return { role: "user", text: `[Earlier conversation summary]: ${text}` };
```

也就是说，**当前的摘要是一段自由文本**，没有「目标 / 约束 / 进度 / 决策 / 下一步」这类结构化分区。`SummarizingOptions.summarizer` 留了注入点，调用方可以传自定义摘要器换掉默认实现。

## 组合：pipeContextManagers

多个管理器可以用 `pipeContextManagers` 串成一个，按顺序逐个 `shape`，前一个的输出是后一个的输入：

```ts
pipeContextManagers(
  toolResultTruncator({ maxCharsPerResult: 4000 }),  // 先把巨型工具结果压扁
  tokenBudgetContextManager({ maxTokens: 128000 }),  // 再按总预算裁
);
```

这让「先截断单条、再控总量」这类组合策略不必写成一个大实现——每个管理器只关心一件事。

## 默认是透传：能力在、但没接上

需要强调的现状：尽管这套子系统完整存在，**`createAgent` 的默认上下文管理器是 `passthroughContextManager()`**（`packages/framework/src/create-agent.ts`），[Harness](../harness/harness.md) 的 `createGenericAgent` 也没有覆盖它。也就是说，**通用 Agent 当前跑的是「不裁剪」**——历史会一直原样喂给模型，直到撞上窗口上限。滑动窗口、token 预算、摘要压缩这些实现都已就绪，但要生效得由调用方显式传入 `config.contextManager`。

这是一个「能力已落地、默认未启用」的状态。把哪种实现提为默认、摘要要不要升级成结构化分区，属于[未来工作](../roadmap/future-work.md)的范畴。

## 关联页面

- [Framework 运行循环](framework.md)
- [运行时插件机制](plugin.md)
- [Harness 默认装配](../harness/harness.md)
- [事实与投影](../foundations/facts-and-projections.md)
- [未来工作](../roadmap/future-work.md)
