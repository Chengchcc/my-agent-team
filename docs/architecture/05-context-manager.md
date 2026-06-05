# ContextManager 架构设计

## 一、先定问题：为什么需要 ContextManager

在讨论设计前，先确认这个组件存在的第一性理由。否则就是在给框架塞概念。

### 第一性事实

LLM 调用有**输入长度上限**（context window）。Agent loop 跑得越久，messages 越长，最终会撞墙。这是不可否认的事实。

### 当前 framework 怎么处理

最初方案：用 `slidingWindow` plugin 挂 `beforeModel` 钩子，每次调 LLM 前裁剪。

```ts
slidingWindow({ maxTurns: 20 })
```

### 为什么 slidingWindow plugin 不够

随着场景变复杂，单一裁剪策略撑不住：

| 痛点 | slidingWindow 的问题 |
|---|---|
| 不同 model 的 context window 不同 | plugin 不知道 model 容量，只能写死 turn 数 |
| 用户消息 + system + 工具结果各占多少 token | 简单 turn count 无法精确控制 |
| 长内容需要摘要而不是丢弃 | plugin 接口只能 transform messages，无法触发摘要子任务 |
| 工具结果太大（如读了个 10k 行的文件） | 不能简单丢，要替换成摘要引用 |
| 多轮过后老的 tool_use / tool_result 配对要一起删 | plugin 写裁剪逻辑容易留下孤儿 block |

**单个 plugin 解决不了**，但**多个 plugin 互相影响**会爆炸。这是新抽象的信号。

### Rule of Three 检验

有 3 个真实诉求吗？

1. **基于 token 数裁剪**（不是 turn 数） — 真实，每个 model 都需要
2. **保留首条 system message + 最近 N 条** — 真实，否则人格会丢
3. **大 tool 结果转摘要** — 真实，读完整个仓库的 grep 结果不能全塞

**够 3 个，可以抽**。

---

## 二、ContextManager 的定位

**ContextManager = agent 在每次调 LLM 前，决定"实际送进去的 messages 是什么"的策略层。**

它和 Checkpointer 是兄弟概念，但解决不同问题：

| 维度 | Checkpointer | ContextManager |
|---|---|---|
| 关注点 | 状态在**时间维度**上的持久与恢复 | 状态在**空间维度**上的压缩与塑形 |
| 时机 | tool 边界（save）、resume（load） | 每次 model.stream 之前 |
| 改变 thread.messages 吗？ | 不改（save 是只读 snapshot） | **不直接改 thread.messages**，只决定送给 LLM 的视图 |
| 默认实现 | InMemoryCheckpointer | PassthroughContextManager（原样传） |
| 是否 framework 内化 | 是 | 是 |

---

## 三、关键设计决策：不能改 thread.messages

这是最容易踩的坑，必须先讲。

**反模式**：ContextManager 在 `beforeModel` 直接修改 `thread.messages`（删除老消息）。

**为什么不行**：

- `thread.messages` 是**真相** —— 持久化、UX 显示、fork 都依赖它
- 一旦真删，**不可恢复** —— 用户切回长上下文 model 也救不回
- 删除会破坏 Checkpointer 的"完整 thread"语义

**正确模型**：

```
thread.messages           ← 永远完整，append-only
       ↓
ContextManager.shape()    ← 纯函数，产出"视图"
       ↓
modelInput: Message[]     ← 临时数据，只喂给 model.stream()
       ↓
model.stream(modelInput)
       ↓
新的 assistant message
       ↓
append 回 thread.messages（完整版）
```

**类比**：thread.messages 是数据库表，ContextManager 是 SELECT 查询的 view。view 可以裁剪、聚合、变形，但不动表。

---

## 四、接口设计

### 核心契约

```ts
interface ContextManager {
  /**
   * 在每次调 LLM 前被 framework 调用。
   *
   * @param ctx 上下文（threadId、model 元信息、signal）
   * @param messages 当前 thread.messages 的只读视图
   * @returns 实际送给 model.stream() 的 messages
   *   - 必须是合法的 API 输入序列（user/assistant 配对、tool_use/tool_result 配对）
   *   - 不能 mutate 入参
   */
  shape(
    ctx: ContextManagerContext,
    messages: readonly Message[],
  ): Message[] | Promise<Message[]>;
}

interface ContextManagerContext {
  threadId: string;
  signal?: AbortSignal;
}
```

`modelInfo` 和 `systemPrompt` 不进 ctx：token 限制在 ContextManager **构造时**传入（`tokenBudgetContextManager({ maxTokens, tokenizer })`），system prompt 直接从 `messages[0]` 取。
```

### 配套：组合多个策略

```ts
/** 把多个 ContextManager 串成管道，前一个的输出作为后一个的输入 */
export function pipeContextManagers(
  ...managers: ContextManager[]
): ContextManager {
  return {
    async shape(ctx, messages) {
      let current = [...messages];
      for (const m of managers) {
        current = await m.shape(ctx, current);
      }
      return current;
    },
  };
}
```

**关键**：组合在 framework 层提供，不引入"插件优先级"概念。用户用 `pipeContextManagers(a, b, c)` 显式声明顺序。

---

## 五、内置实现

### 1. `passthroughContextManager`（默认）

```ts
export const passthroughContextManager = (): ContextManager => ({
  async shape(_, messages) {
    return [...messages];
  },
});
```

- `createAgent` 不传 contextManager 时默认用它
- 保证 framework 行为统一（永远有一层 shape 调用）
- 适合：短对话、调试

### 2. `slidingWindowContextManager`

```ts
slidingWindowContextManager({ maxTurns: 20, keepFirst: true }): ContextManager
```

- 保留最近 N 轮 user/assistant 对话
- `keepFirst: true` 时保留首条（通常是 system 或 user 的设定）
- **配对感知**：删除时不会留下孤儿 tool_use（删 assistant 时同步删后续 tool_result）

### 3. `tokenBudgetContextManager`

```ts
tokenBudgetContextManager({
  maxTokens: 100_000,
  tokenizer: tiktoken('claude-sonnet-4'),
  reserveForOutput: 4096,
}): ContextManager
```

- 从尾部往前累加 token，直到接近 `maxTokens - reserveForOutput`
- 比 sliding window 精确，但需要引 tokenizer 依赖
- **tokenizer 是参数**，framework 不强依赖 tiktoken

### 4. `summarizingContextManager`（高阶）

```ts
summarizingContextManager({
  triggerAt: 80_000,           // token 数到这个就触发
  keepRecent: 10,              // 最近 N 轮原样保留
  summarizer: async (oldMessages) => {
    // 用户提供：怎么把老消息变成一条摘要
    return { role: 'user', content: 'Summary: ...' };
  },
}): ContextManager
```

- 触发条件满足时，**异步**调用 `summarizer` 把老消息压缩成单条
- summarizer 函数由用户提供（通常是再起一个 mini agent 跑摘要）
- **不内置 LLM 调用** —— framework 不知道用哪个 model 摘要，让用户给

### 5. `toolResultTruncator`

```ts
toolResultTruncator({ maxBytesPerResult: 4000 }): ContextManager
```

- 扫描 messages，把超长的 `tool_result` content 截断 + 加 `...[truncated]` 标记
- 适合长文件读取、大 grep 结果场景

---

## 六、典型使用形态

### 简单场景

```ts
createAgent({
  model,
  tools,
  contextManager: slidingWindowContextManager({ maxTurns: 20 }),
});
```

### 组合场景（coding harness 典型配置）

```ts
createAgent({
  model: anthropicModel,
  tools: codingTools,
  contextManager: pipeContextManagers(
    toolResultTruncator({ maxBytesPerResult: 8000 }),  // 先压每条
    tokenBudgetContextManager({                         // 再卡总量
      maxTokens: 180_000,
      tokenizer: tiktoken('claude-sonnet-4'),
      reserveForOutput: 8192,
    }),
  ),
});
```

执行顺序：thread.messages → truncate 长 tool result → 卡总 token → 送 LLM。

### 高阶场景（长对话 + 摘要）

```ts
createAgent({
  model,
  tools,
  contextManager: pipeContextManagers(
    summarizingContextManager({
      triggerAt: 100_000,
      keepRecent: 10,
      summarizer: async (old) => {
        const summary = await summaryAgent.run(
          `Summarize:\n${JSON.stringify(old)}`
        );
        return { role: 'user', content: `[Earlier conversation summary]: ${summary}` };
      },
    }),
    tokenBudgetContextManager({ maxTokens: 180_000, tokenizer }),
  ),
});
```

---

## 七、Framework 集成点

### 时机契约

```
agent.run(input)
  ↓ thread.messages.push(user msg)
  ↓ checkpointer.save(...)               # 持久化完整版
  ↓ loop:
    ↓ shapedMessages = await contextManager.shape(ctx, thread.messages)
    ↓ pluginHooks.beforeModel(ctx, shapedMessages)  # plugin 可以再 transform
    ↓ model.stream(shapedMessages)
    ↓ thread.messages.push(assistant msg)  # 永远 push 到完整版
    ↓ ...
```

**关键纪律**：

1. **ContextManager 先于 plugin.beforeModel 执行** —— ContextManager 是 framework 层，plugin 是扩展层
2. **shape 的结果不污染 thread.messages** —— framework 保证 push 用的是 model 返回的新消息，不是 shape 后的
3. **shape 每次 loop step 调一次** —— 不是每个 chunk 调一次

### Checkpointer 看到的是完整版

```
持久化：checkpointer.save(threadId, thread.messages)   # 完整 messages
喂 LLM：model.stream(contextManager.shape(messages))   # 裁剪视图
```

恢复时也是恢复完整版，下次 shape 时重新裁剪。**ContextManager 是无状态的**。

---

## 八、ContextManager vs Plugin.beforeModel 的边界

| 维度 | ContextManager | Plugin.beforeModel |
|---|---|---|
| 数量 | **唯一**（一个 agent 一个） | 多个 |
| 职责 | **空间塑形**：裁剪、摘要、token 控制 | 内容修饰：脱敏、加 system context、注入信息 |
| 调用顺序 | **永远先于** plugin | 永远后于 ContextManager |
| 输出语义 | **完整、合法的 API 输入** | 仅做局部修改 |
| 是否 framework 内化 | 是（默认 passthrough） | 否（可选） |

### 判断标准

| 场景 | 用哪个 |
|---|---|
| 把 messages 砍到 20 轮 | ContextManager |
| 用 token 数控制长度 | ContextManager |
| 把老消息合并成摘要 | ContextManager |
| 给每次 user message 加上当前时间 | Plugin |
| 调 LLM 前给 PII 打码 | Plugin |
| 把 system prompt 拼到 messages 前 | Plugin |
| 注入项目元信息 | Plugin |

**根本区别**：

- ContextManager 回答 "**这次调 LLM 用哪些消息**"
- Plugin.beforeModel 回答 "**这些消息要不要做点修饰**"

第一个是**架构问题**（每个 agent 必须答），第二个是**业务问题**（可选）。

---

## 九、为什么不直接合并到 ChatModel

有人会问：context 管理是 model 的事，为什么不让 model adapter 自己处理？

**反对理由**：

1. **ChatModel 不该知道 messages 来源** —— 它的契约是"给我 messages，我返回 chunks"。塞裁剪策略进 adapter，每个 adapter 都要实现一遍
2. **裁剪策略和 model 选择独立变化** —— Anthropic 用户也可能想用 token budget；OpenAI 用户也可能想用 sliding window
3. **测试性** —— ContextManager 是纯函数（in: messages, out: messages），易测；混进 model adapter 要 mock LLM
4. **多策略组合** —— `pipeContextManagers` 在 ChatModel 里实现别扭

**结论**：ContextManager 必须独立于 ChatModel 存在。

---

## 十、模块边界

| 模块 | 职责 | 归属 |
|---|---|---|
| `ContextManager` | 接口定义 | framework |
| `passthroughContextManager` | 默认实现 | framework |
| `slidingWindowContextManager` | 按轮数裁剪 | framework |
| `tokenBudgetContextManager` | 按 token 裁剪 | framework |
| `toolResultTruncator` | 截断单条 tool_result | framework |
| `summarizingContextManager` | 摘要压缩 | framework |
| `pipeContextManagers` | 组合工具 | framework |
| tokenizer 实现（tiktoken 等） | 由用户引入 | **不进 framework** |

---

## 十一、设计纪律

1. **ContextManager 永远存在** —— 不传 = `passthroughContextManager`，没有 `contextManager: undefined`
2. **shape 是纯函数** —— 不 mutate 入参，不持久化状态（要状态用闭包）
3. **不改 thread.messages** —— framework 用 shape 的结果调 model，thread.messages 是真相
4. **不引入"裁剪策略优先级"枚举** —— 用 `pipeContextManagers` 显式组合
5. **不内置 tokenizer** —— 用户传 `tokenizer: (text: string) => number`
6. **不内置 LLM 摘要** —— `summarizer` 是用户提供的函数
7. **shape 返回的 messages 必须合法** —— framework 不做二次校验（fail fast），但文档要警告：tool_use 和 tool_result 必须配对

---

## 十二、与三个核心组件的关系

```
                   ┌─────────────────────────┐
                   │   thread.messages       │  ← 真相，append-only
                   │   (完整历史)             │
                   └────────────┬────────────┘
                                │
                ┌───────────────┼───────────────┐
                ↓               ↓               ↓
        ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
        │ Checkpointer │ │ContextManager│ │   Plugins    │
        │ (持久化完整) │ │ (塑形视图)   │ │ (观察/修饰)  │
        └──────────────┘ └──────┬───────┘ └──────┬───────┘
                                │                │
                                ↓                ↓
                       ┌─────────────────────────────┐
                       │  shapedMessages             │
                       │  (这次调 LLM 用的)          │
                       └─────────────┬───────────────┘
                                     ↓
                              model.stream(...)
```

**三层职责**：

- **Checkpointer**：守住"完整真相"在时间上的可恢复性
- **ContextManager**：把完整真相塑形成"LLM 能装下"的视图
- **Plugin.beforeModel**：在视图上做最后的修饰（脱敏、注入信息）
