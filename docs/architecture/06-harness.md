# Harness 的定义

## 一句话定义

**Harness 是一个面向特定任务领域的、开箱即用的 agent 成品 —— 它把 framework、model adapter、tools、system prompt、plugin 组合按一个具体场景固化下来，让用户用一行代码就能跑。**

---

## 词源直觉

"Harness" 在英文里的本义是**马具/挽具** —— 把马（动力）和车（载荷）连起来的一整套绑带，让一匹散养的马变成能拉车的工具。

放到 agent 语境：

- **马** = LLM（原始能力）
- **车** = 用户的业务任务
- **harness** = 把 LLM 套上、配上工具、配上行为约束，让它能干活的那套绑带

所以 harness 不创造新能力，**它做的是约束、装配、就绪化**。

---

## 三个必要条件

一个包是 harness，**必须同时满足**：

### 1. 领域闭合

对"用户要做什么"有具体假设。

- ✅ `harness-coding` —— 假设用户在写代码
- ✅ `harness-research` —— 假设用户在做信息收集
- ❌ `framework` —— 不知道用户要做什么

### 2. 零装配

用户**不需要懂 framework 概念**就能用。

```ts
// Harness 的典型 API
const agent = createCodingAgent({ workdir: './my-project' });
for await (const msg of agent.run('add a unit test')) { ... }
```

用户不需要知道：
- 什么是 `ChatModel` —— harness 内部已经选好（Anthropic / OpenAI / ...）
- 什么是 `Tool` —— harness 已经内置好工具集
- 什么是 `Plugin` —— harness 已经选好需要的 plugin
- 什么是 `system prompt` —— harness 已经写好

### 3. 行为固化

同一个 harness 调用，行为应该**稳定可预期**。

- 用 `harness-coding` 永远遵循同一套编码 agent 行为（同样的 prompt、同样的 tool 边界、同样的权限策略）
- 升级 harness 版本是预期行为变更的唯一来源
- **harness 不应暴露大量 "mode" 开关** —— 真有两种行为，做两个 harness

---

## Harness 由什么组成

一个 harness 包内部必然包含这 5 类东西：

```
harness-X/
├── system-prompt.ts      # 写死的提示词，定义 agent 人格和能力边界
├── tools/                # 该领域需要的 tool 集合
│   ├── read.ts
│   ├── write.ts
│   └── bash.ts
├── model-selection.ts    # 选用的 model adapter（如 AnthropicChatModel）
├── plugin-preset.ts      # 选用的 plugin 组合（如 slidingWindow + permission + checkpoint）
└── index.ts              # 对外暴露一个/几个工厂函数
```

少任何一类，都不是完整 harness。

---

## Harness 不是什么

| 不是 | 区别 |
|---|---|
| **不是 framework** | framework 是装配套件，harness 是装配成品 |
| **不是 adapter** | adapter 只翻译 model API，不写 prompt、不选 tool |
| **不是 tool 包** | tool 包提供能力，harness 决定用哪些能力做什么任务 |
| **不是 plugin** | plugin 是 framework 的扩展点，harness 是消费者 |
| **不是 CLI** | CLI 可能基于 harness 构建，但 harness 本身是库；harness 也可以被 web app / SDK 调用 |
| **不是 multi-agent 编排** | harness 是单 agent 的成品；多 agent 编排是更高一层（M5+） |

---

## 一个具体例子：`harness-coding`

```ts
// 用户视角：
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
// harness-coding 内部（伪代码）：
export function createCodingAgent(opts: CodingAgentOptions): Agent {
  return createAgent({
    model: new AnthropicChatModel({
      apiKey: opts.apiKey,
      model: 'claude-sonnet-4',          // ← 写死
    }),
    tools: [                              // ← 写死的工具集
      readFile(opts.workdir),
      writeFile(opts.workdir),
      bash({ cwd: opts.workdir }),
      grep(opts.workdir),
      glob(opts.workdir),
    ],
    systemPrompt: CODING_SYSTEM_PROMPT,  // ← 写死的人格
    contextManager: slidingWindowContextManager({ maxTurns: 20 }),
    checkpointer: fileCheckpointer({
      dir: path.join(opts.workdir, '.agent'),
    }),
    plugins: [
      permissionPlugin({ mode: 'ask' }), // ← harness 特有 plugin
    ],
  });
}
```

注意 **用户输入只有 `apiKey` 和 `workdir`** —— 业务参数，不是装配参数。

---

## 判断一个东西是不是 harness 的 checklist

1. **能不能在 README 里写 "for X tasks" 这种领域定语？**
   - 能（"for coding tasks"、"for research tasks"）→ harness 候选
   - 不能 → 不是 harness

2. **它的工厂函数签名里有 `model` 或 `tools` 参数吗？**
   - 有 → 是 framework，不是 harness
   - 没有 → 是 harness 候选

3. **它的包里有 system prompt 字符串吗？**
   - 有 → harness 候选成立
   - 没有 → 不是 harness（最多是 framework + adapter 的组合）

4. **同样的输入，行为稳定吗？**
   - 稳定 → harness
   - 暴露大量 mode/strategy 开关让用户挑 → 装配套件，不是成品 → 应拆成多个 harness

---

## 总结

**Harness = framework 装配套件 + 一组确定的选型决策（model + tools + prompt + plugins） + 一个领域定语**。

它的存在价值：让 **不懂 framework** 的用户也能享用 framework 的能力，**通过牺牲灵活性换取易用性**。

判断标准：**领域闭合 + 零装配 + 行为固化**，三条缺一不可。
