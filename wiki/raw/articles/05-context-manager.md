# ContextManager

Framework 的**内化能力**，在每次调 LLM 前决定"实际送进去的 messages 是什么"的策略层。它和 [Checkpointer](./04-checkpointer.md) 是兄弟——一个解决"状态在时间维度的持久与恢复"，一个解决"状态在空间维度的压缩与塑形"。

---

## 为什么需要这个抽象

LLM 调用有**输入长度上限**（context window）。Agent loop 跑得越久，messages 越长，最终撞墙。这是不可否认的事实。

最初方案：用一个 `slidingWindow` plugin 挂 `beforeModel` 钩子裁剪。随着场景变复杂，单一裁剪策略撑不住：

| 痛点 | slidingWindow plugin 的问题 |
|---|---|
| 不同 model 的 context window 不同 | plugin 不知道 model 容量，只能写死 turn 数 |
| 用户消息 + system + 工具结果各占多少 token | 简单 turn count 无法精确控制 |
| 长内容需要摘要而不是丢弃 | plugin 接口只能 transform messages，无法触发摘要子任务 |
| 工具结果太大（如读了个 10k 行的文件） | 不能简单丢，要替换成摘要引用 |
| 多轮过后老的 tool_use / tool_result 配对要一起删 | plugin 写裁剪逻辑容易留下孤儿 block |

**单个 plugin 解决不了，多个 plugin 互相影响会爆炸**——这是新抽象的信号。

Rule of three 检验：

1. **基于 token 数裁剪**（不是 turn 数） — 真实，每个 model 都需要
2. **保留首条 system message + 最近 N 条** — 真实，否则人格会丢
3. **大 tool 结果转摘要** — 真实，读完整个仓库的 grep 结果不能全塞

够 3 个，可以抽。

---

## 定位

**ContextManager = agent 在每次调 LLM 前，决定"实际送进去的 messages 是什么"的策略层。**

和 Checkpointer 的对照：

| 维度 | Checkpointer | ContextManager |
|---|---|---|
| 关注点 | 状态在**时间维度**上的持久与恢复 | 状态在**空间维度**上的压缩与塑形 |
| 时机 | tool 边界（save）、resume（load） | 每次 `model.stream` 之前 |
| 是否改 `thread.messages` | 不改（save 是只读 snapshot） | **不直接改**，只决定送给 LLM 的视图 |
| 默认实现 | `inMemoryCheckpointer` | `passthroughContextManager`（原样传） |
| 是否 framework 内化 | 是 | 是 |

---

## 关键设计：不能改 thread.messages

这是最容易踩的坑，必须先讲。

**反模式**：ContextManager 在 shape 里直接修改 `thread.messages`（删除老消息）。

**为什么不行**：

- `thread.messages` 是**真相** —— 持久化、UX 显示、fork 都依赖它
- 一旦真删，**不可恢复** —— 用户切回长上下文 model 也救不回
- 删除会破坏 Checkpointer 的"完整 thread"语义

**正确模型**：

```mermaid
flowchart TD
  TM["thread.messages<br/>（真相，append-only）"] -->|读| CM["ContextManager.shape<br/>（纯函数）"]
  CM -->|产出视图| MI[modelInput: Message[]]
  MI --> MS[model.stream]
  MS --> NA[新 assistant message]
  NA -->|append| TM
```

类比：`thread.messages` 是数据库表，ContextManager 是 SELECT 查询的 view。view 可以裁剪、聚合、变形，但不动表。

---

## 接口

### 核心契约

```ts
interface ContextManager {
  shape(
    ctx: ContextManagerContext,
    messages: readonly Message[],
  ): Message[] | Promise<Message[]>;
}

interface ContextManagerContext {
  threadId: string;
  signal?: AbortSignal;
  logger: Logger;       // framework 注入——CM 可记日志，level 受控
  model: ChatModel;     // framework 注入 agent 配的 model——供 summarizer 等调用
}
```

**为什么 ctx 暴露 `model` 和 `logger` 而不暴露 `checkpointer`**：
- `model` — summarizingContextManager 需要调 LLM 做摘要；注入 model 让用户不必重复创建 model 实例
- `logger` — CM 实现可记 shape 行为（debug 级别），与 HookContext 对齐
- 不暴露 `checkpointer` — CM 不读写持久状态
- 不暴露 `contextManager` — 避免循环引用

### 组合：pipeContextManagers

```ts
/** 把多个 ContextManager 串成管道，前一个的输出作为后一个的输入 */
export function pipeContextManagers(...managers: ContextManager[]): ContextManager {
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

组合在 framework 层提供，不引入"插件优先级"概念。用户用 `pipeContextManagers(a, b, c)` 显式声明顺序。

**错误传播契约**：任何一个 manager 的 `shape()` 抛错，pipe 立刻 throw，**不吞、不降级、不跳过**。理由是 ContextManager 决定的是"送给 LLM 的内容"——一个 manager 失败意味着视图不完整或非法，继续往下传等于把损坏数据塞给 LLM。framework 收到错误后整轮 abort（与 `before*` 钩子抛错的处理一致）。要做"某个 manager 失败时跳过"，由用户在自己的 manager 内部 try/catch 包好——不要让 framework 默认吞错。

---

## 内置实现

### 1. `passthroughContextManager`（默认）

```ts
export const passthroughContextManager = (): ContextManager => ({
  async shape(_, messages) {
    return [...messages];
  },
});
```

`createAgent` 不传 contextManager 时默认用它。保证 framework 行为统一（永远有一层 shape 调用）。适合短对话、调试。

### 2. `slidingWindowContextManager`

```ts
slidingWindowContextManager({
  maxTurns: number;
  keepFirst?: number;       // 默认 0，保留前 N 条原始 messages
}): ContextManager
```

保留最近 N 轮 user/assistant 对话。`keepFirst` 是数字（前 N 条），**不识别 system**——"前 N 条"是纯位置操作。示例：`[system, u1, a1, u2, a2, u3, a3]`, `maxTurns=2, keepFirst=1` → `[system, u2, a2, u3, a3]`。

**配对感知**：删除时不会留下孤儿 block（删 assistant 同步删后续 tool_result；删 tool_result 同步删前面对应的 assistant）。配对完整性 > maxTurns 精确数——宁可少保留 1 turn 也不留孤儿。

重叠区间：如果 keepFirst 和 maxTurns 窗口重叠，按位置去重不重复保留。

### 3. `tokenBudgetContextManager`

```ts
tokenBudgetContextManager({
  maxTokens: number;
  reserveForOutput?: number;       // 默认 4096
  countTokens?: (messages: readonly Message[]) => number | Promise<number>;
}): ContextManager
```

从尾部往前累加 token，直到接近 `maxTokens - reserveForOutput`。比 sliding window 精确。

**三段式 token 计数 fallback**：
1. 用户传 `countTokens` → 用用户函数
2. `ctx.model.countTokens?` → adapter 提供精确实现
3. `Math.ceil(JSON.stringify(messages).length / 4)` → 字符近似兜底

```ts
const APPROX_CHARS_PER_TOKEN = 4;
function approximateTokens(messages: readonly Message[]): number {
  return Math.ceil(JSON.stringify(messages).length / APPROX_CHARS_PER_TOKEN);
}
```

字符近似不精确（英文偏小 10-20%，中文偏大），但保证任何情况下都能跑。要精确的用户传 `countTokens` 或让 adapter 实现 `ChatModel.countTokens`。

### 4. `summarizingContextManager`

```ts
summarizingContextManager({
  triggerAt: number;
  keepRecent: number;
  summarizer?: (old: Message[], model: ChatModel) => Promise<Message>;
  summarizerModel?: ChatModel;       // 自定义摘要用 model；不传用 ctx.model
}): ContextManager
```

触发条件满足时，调 LLM 把老消息压缩成单条。

**三段式 summarizer**：
1. 用户传 `summarizer` → 完全自定义
2. 用户传 `summarizerModel` → 内置摘要 prompt + 用户给的 model
3. 都不传 → 用 `ctx.model` + 内置摘要 prompt（开箱即用）

```ts
async function defaultSummarize(old: Message[], model: ChatModel, signal?: AbortSignal): Promise<Message> {
  const result = await collectStream(model.stream(
    [...old, { role: 'user', content: 'Summarize the conversation above concisely. Keep key decisions and facts.' }],
    { signal },
  ));
  const text = result.blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return { role: 'user', content: `[Earlier conversation summary]: ${text}` };
}
```

### 5. `toolResultTruncator`

```ts
toolResultTruncator({ maxCharsPerResult: number }): ContextManager
```

扫描 messages，把超长的 `tool_result` content 截断 + 加 `...[truncated, N chars]` 标记。截断单位是 `string.length`（UTF-16 code unit），不是 byte。不处理 surrogate pair 半残——99% 场景无所谓，严格用户自己再包一层 CM。适合长文件读取、大 grep 结果场景。

---

## 典型使用形态

### 简单

```ts
createAgent({
  model, tools,
  contextManager: slidingWindowContextManager({ maxTurns: 20 }),
});
```

### 组合（coding harness 典型配置）

```ts
createAgent({
  model: anthropicModel,
  tools: codingTools,
  contextManager: pipeContextManagers(
    toolResultTruncator({ maxCharsPerResult: 8000 }),  // 先压每条
    tokenBudgetContextManager({                         // 再卡总量
      maxTokens: 180_000,
      tokenizer: tiktoken('claude-sonnet-4'),
      reserveForOutput: 8192,
    }),
  ),
});
```

执行顺序：thread.messages → truncate 长 tool result → 卡总 token → 送 LLM。

### 高阶（长对话 + 摘要）

```ts
createAgent({
  model, tools,
  contextManager: pipeContextManagers(
    summarizingContextManager({
      triggerAt: 100_000,
      keepRecent: 10,
      summarizer: async (old) => {
        const summary = await summaryAgent.run(`Summarize:\n${JSON.stringify(old)}`);
        return { role: 'user', content: `[Earlier conversation summary]: ${summary}` };
      },
    }),
    tokenBudgetContextManager({ maxTokens: 180_000, tokenizer }),
  ),
});
```

---

## Framework 集成点

### 时机契约

```ts
async function* runAgent(input) {
  messages.push({ role: 'user', content: input });
  await checkpointer.save(threadId, messages);   // 持久化完整版

  for (let step = 0; step < maxSteps; step++) {
    const shaped = await contextManager.shape(ctx, messages);   // ← 空间塑形
    const final = await firePipeline('beforeModel', shaped);    // plugin 再 transform
    const assistant = await model.stream(final);
    messages.push(assistant);                                   // 完整版仍 append
    // ... tools ...
  }
}
```

关键纪律：

1. **ContextManager 先于 plugin.beforeModel 执行** — ContextManager 是 framework 层，plugin 是扩展层
2. **shape 的结果不污染 thread.messages** — framework 保证 push 用的是 model 返回的新消息，不是 shape 后的
3. **shape 每次 loop step 调一次** — 不是每个 chunk 调一次

### Checkpointer 看到的是完整版

```
持久化：checkpointer.save(threadId, thread.messages)   # 完整 messages
喂 LLM：model.stream(contextManager.shape(messages))   # 裁剪视图
```

恢复时也是恢复完整版，下次 shape 时重新裁剪。**ContextManager 是无状态的**。

### Resume 与 ContextManager 的配对契约

`agent.resume()` 从 Checkpointer 读出完整 messages → 补 `tool_result` → 进入 loop → **正常调一次 `shape()`**。

这意味着 ContextManager 实现者必须保证 shape **幂等**且**结果与历史无关**：同一份 messages 在第一次执行时被 shape 成 X，崩溃恢复后再次被 shape 也必须是 X（或语义等价）。

- ✅ `slidingWindow` / `tokenBudget` / `toolResultTruncator` — 纯函数，天然满足
- ⚠️ `summarizingContextManager` — 若 summarizer 每次跑都生成不同摘要文本，resume 后 LLM 看到的"早期对话摘要"会变，但语义不变，**可接受**
- ❌ 在 closure 里维护"我已经裁过了"状态 — resume 后状态丢失，行为不可预测，**禁止**

framework **不**在 resume 路径上跳过 ContextManager——跳过会导致首条 model.stream 用完整 messages、超 token。统一走 shape 是唯一安全选择。

---

## ContextManager vs Plugin.beforeModel 的边界

| 维度 | ContextManager | Plugin.beforeModel |
|---|---|---|
| 数量 | **唯一**（一个 agent 一个） | 多个 |
| 职责 | **集合选择**：哪些 message 进 LLM | **元素修饰**：每条 message 长什么样 |
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

### 自检决策树

```
要变形 messages，问自己：
1. 我在决定"哪些 message 进 LLM" 吗？  →  ContextManager
2. 我在做 token / 数量 / 配对感知的裁剪吗？  →  ContextManager
3. 我在改单条 message 的 content / 加新 message 吗？  →  beforeModel
4. 我只是想观察，不改任何东西？  →  afterModel
5. 我同时想做 1+3？  →  分成两个组件，ContextManager 一个 + Plugin 一个
```

根本区别：

- **ContextManager 回答"这次调 LLM 用哪些消息"**（集合问题）
- **Plugin.beforeModel 回答"这些消息要不要做点修饰"**（元素问题）

第一个是**架构问题**（每个 agent 必须答），第二个是**业务问题**（可选）。

### 双层协作示例

```ts
createAgent({
  model, tools,
  contextManager: pipeContextManagers(
    toolResultTruncator({ maxCharsPerResult: 8000 }),
    tokenBudgetContextManager({ maxTokens: 180_000 }),
  ),
  plugins: [
    injectMetadata({ projectName: 'my-agent', cwd: process.cwd() }),
    redactor({ patterns: [/AKIA[0-9A-Z]{16}/g] }),
  ],
});
```

执行顺序：ContextManager 裁剪集合 → `injectMetadata` 修饰元素 → `redactor` 修饰元素 → 送 LLM。每层只做一件事，顺序不可换。

---

## 为什么不直接合并到 ChatModel

有人会问：context 管理是 model 的事，为什么不让 model adapter 自己处理？

反对理由：

1. **ChatModel 不该知道 messages 来源** — 它的契约是"给我 messages，我返回 chunks"。塞裁剪策略进 adapter，每个 adapter 都要实现一遍
2. **裁剪策略和 model 选择独立变化** — Anthropic 用户也可能想用 token budget；OpenAI 用户也可能想用 sliding window
3. **测试性** — 大部分 ContextManager 是纯函数（in: messages, out: messages），易测；summarizing 需要 model 但通过 ctx 注入，mock model 即可
4. **多策略组合** — `pipeContextManagers` 在 ChatModel 里实现别扭

结论：**ContextManager 必须独立于 ChatModel 存在**。

---

## 设计纪律

1. **ContextManager 永远存在** — 不传 = `passthroughContextManager`，没有 `contextManager: undefined`
2. **shape 是纯函数** — 不 mutate 入参，不持久化状态（要状态用闭包）。summarizing 调 LLM → 语义幂等（非严格幂等），**可接受**
3. **不改 thread.messages** — framework 用 shape 的结果调 model，thread.messages 是真相
4. **不引入"裁剪策略优先级"枚举** — 用 `pipeContextManagers` 显式组合
5. **token 计数三段式** — 用户传 countTokens > `ctx.model.countTokens?` > 字符近似兜底。framework 不引 tiktoken
6. **摘要三段式** — 用户传 summarizer > 用户传 summarizerModel > 用 `ctx.model` + 内置 prompt。framework 不硬编码摘要策略
7. **shape 返回的 messages 必须合法** — framework 不做二次校验（fail fast），文档警告：tool_use 和 tool_result 必须配对
8. **system prompt 由 createAgent 管理** — CM 看到的是已带 system 的完整 messages，自由决定保留/裁剪。`tokenBudget` 可能裁掉 system，用户需保护时用 `slidingWindow({ keepFirst: 1 })` 兜底

---

## 与三个核心组件的关系

```mermaid
flowchart TD
  TM["thread.messages<br/>真相,append-only"]
  TM --> CP[Checkpointer<br/>持久化完整]
  TM --> CMR[ContextManager<br/>塑形视图]
  TM --> PG[Plugins<br/>观察/修饰]
  CMR --> SM[shapedMessages<br/>这次调 LLM 用的]
  PG -.beforeModel.-> SM
  SM --> M[model.stream]
```

三层职责：

- **[Checkpointer](./04-checkpointer.md)**：守住"完整真相"在时间上的可恢复性
- **ContextManager**（本页）：把完整真相塑形成"LLM 能装下"的视图
- **[Plugin](./03-plugin.md).beforeModel**：在视图上做最后的修饰（脱敏、注入信息）
