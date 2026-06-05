# Harness

**领域专用的、开箱即用的 agent 成品**。把 [Framework](./02-framework.md) + model adapter + tools + system prompt + plugins 按一个具体场景固化，用户一行代码起跑。

---

## 词源

"Harness" 本义**马具/挽具** — 把马（动力）和车（载荷）连起来的绑带，让散养的马变成拉车的工具。

agent 语境：

- **马** = LLM（原始能力）
- **车** = 业务任务
- **Harness** = 把 LLM 套上、配上 tools、配上行为约束的那套绑带

Harness **不创造新能力** — 它做的是**约束、装配、就绪化**。

---

## 三个必要条件

一个包是 harness，**三条缺一不可**：

| 条件 | 含义 |
|---|---|
| **Domain-closed** | 对"用户要做什么"有具体假设。`harness-coding` 假设写代码，`harness-research` 假设信息收集 |
| **Zero-assembly** | 用户不需要懂 Framework。API 参数是业务概念（`workdir`），不是装配概念（`model`、`tools`） |
| **Behavior-locked** | 同一 harness 行为稳定可预期。升级版本是唯一变更来源。不暴露大量 mode 开关 |

---

## 内部构成

一个 harness 包必然包含这 5 类东西：

```
harness-X/
├── system-prompt.ts      # 写死的 prompt
├── tools/                # 该领域的 tool 集合
├── model-selection.ts    # 选用的 adapter（AnthropicChatModel）
├── plugin-preset.ts      # 选用的 plugins（permission 等）
└── index.ts              # 一个/几个工厂函数
```

少任何一类，不是完整 harness。

---

## 例子：`harness-coding`

```ts
// 用户视角 — 零装配：
import { createCodingAgent } from '@my-agent/harness-coding';

const agent = createCodingAgent({
  apiKey: process.env.ANTHROPIC_API_KEY,
  workdir: './my-project',
});

for await (const msg of agent.run('add tests for utils.ts')) {
  console.log(msg);
}
```

```ts
// 内部 — 固化所有选型：
export function createCodingAgent(opts: CodingAgentOptions): Agent {
  return createAgent({
    model: new AnthropicChatModel({
      apiKey: opts.apiKey,
      model: 'claude-sonnet-4',
    }),
    tools: [
      readFile(opts.workdir),
      writeFile(opts.workdir),
      bash({ cwd: opts.workdir }),
      grep(opts.workdir),
      glob(opts.workdir),
    ],
    systemPrompt: CODING_SYSTEM_PROMPT,
    contextManager: slidingWindowContextManager({ maxTurns: 20 }),
    checkpointer: fileCheckpointer({
      dir: join(opts.workdir, '.agent'),
    }),
    plugins: [
      permissionPlugin({ mode: 'ask' }),
    ],
  });
}
```

**用户输入只有 `apiKey` 和 `workdir`** — 业务参数，不是装配参数。

---

## Harness 不是什么

| 不是 | 区别 |
|---|---|
| **Framework** | Framework 是装配套件，Harness 是装配成品 |
| **Adapter** | Adapter 只翻译 model API，不写 prompt、不选 tool |
| **Tool 包** | Tool 包提供能力，Harness 决定用哪些能力做什么任务 |
| **Plugin** | Plugin 是 Framework 的扩展点，Harness 是消费者 |
| **CLI** | CLI 可能基于 Harness 构建，但 Harness 本身是库 |
| **multi-agent** | Harness 是单 agent 成品 |

---

## 判断 checklist

| # | 问题 | → 是 Harness |
|---|---|---|
| 1 | README 里能写 "for X tasks"？ | 能 |
| 2 | 工厂函数签名里没有 `model` 或 `tools`？ | 没有 |
| 3 | 包里有 system prompt 字符串？ | 有 |
| 4 | 同样输入行为稳定，无大段 mode 开关？ | 稳定 |

4 条全中 → Harness。

---

## 总结

**Harness = Framework + 确定的选型（model + tools + prompt + plugins）+ 一个领域定语**。

存在价值：让不懂 Framework 的用户也能享用 Framework 的能力。**通过牺牲灵活性换取易用性**。

判断标准：**领域闭合 + 零装配 + 行为固化**，三条缺一不可。
