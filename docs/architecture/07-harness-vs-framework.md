# Framework 与 Harness 的差别

## 一句话定义

- **Framework**：给一组**白板原料**，让你**自己装配**一个 agent
- **Harness**：给一个**装配好的产品**，你**直接用**就能解决某类具体任务

类比：

| 维度 | Framework | Harness |
|---|---|---|
| 厨房类比 | 锅碗瓢盆 + 灶 | 一份做好的盖饭 |
| 汽车类比 | 发动机+底盘+方向盘卖给车厂 | 整车卖给消费者 |
| 软件类比 | React | Next.js / Create-React-App |
| LangChain | `createAgent({model, tools})` | `createDeepAgent()` / `createReactAgent` 预设 |
| Anthropic | `@anthropic-ai/sdk` | Claude Code CLI |

---

## 三条硬边界

### 1. 是否对"任务领域"做假设

- Framework：**领域无关**。不知道用户要写代码、查数据、还是聊天。`model` 和 `tools` 都是参数
- Harness：**领域强相关**。"coding harness" 就假设是写代码，内置 read/write/bash/grep/glob，system prompt 也是为编码场景写的

**判定题**：如果一个包**写死了 system prompt**，它一定是 harness，不是 framework。

### 2. 是否内置 tools

- Framework：**零内置 tool**。tools 必须由调用方传入
- Harness：**内置一组 tool 套件**。M4 的 `harness-coding` 内置 read/write/bash/grep/glob 五个

**判定题**：包的 `package.json` 里有 `tools-common` 依赖 → harness；只依赖 `core` → framework。

### 3. API 形态：装配式 vs 开箱即用

- Framework：`createAgent({ model, tools, plugins, ... })` —— 用户必须提供至少 2 个参数
- Harness：`createCodingAgent({ workdir })` 或更夸张 `runCLI()` —— 用户提供 0~1 个业务参数即可跑

---

## 你这个项目的具体划分

按 M1 spec 第 2 节四层架构：

```
L4 Harness          ← harness-coding（M4）
   ↓ 依赖
L3 Framework        ← framework（M3）→ Agent + Plugin + Thread
   ↓ 依赖
L2 Runtime          ← core/run.ts
   ↓ 依赖
L1 Protocols        ← core/message.ts, chat-model.ts, tool.ts
```

**Framework 的产出物**：

- `createAgent(config)` 工厂
- `Agent` / `Thread` / `Plugin` / `Checkpointer` 接口
- `definePlugin()` / `slidingWindow()` / `consoleLogger()` / `fileCheckpointer()` 等通用插件
- **不含任何 tool 实现**
- **不含 system prompt**
- **不含具体 model 实例**（只接受 `ChatModel` 接口）

**Harness 的产出物**（M4 设想）：

```ts
// harness-coding 大概长这样
export function createCodingAgent(options: {
  apiKey: string;            // 业务参数
  workdir?: string;
  permissionMode?: 'ask' | 'auto';
}): Agent {
  return createAgent({
    model: new AnthropicChatModel({ apiKey }),         // ← 写死了 model
    tools: [readTool, writeTool, bashTool, grep, glob], // ← 写死了 tools
    systemPrompt: CODING_SYSTEM_PROMPT,                 // ← 写死了 prompt
    plugins: [
      slidingWindow({ maxTurns: 20 }),
      fileCheckpointer({ path: '.agent/checkpoint.json' }),
      permissionPlugin({ mode: options.permissionMode }),
    ],
  });
}
```

Harness 是 **framework + 一组确定的选型 + 一组业务工具 + 一段 system prompt** 的组合包。

---

## 边界灰色地带（容易踩的坑）

### 灰区 1：通用 plugin 算 framework 还是 harness？

- `slidingWindow`、`consoleLogger`、`fileCheckpointer` —— **算 framework**。它们对任务领域无假设
- `permissionPlugin`（命令行权限询问 UI）—— **算 harness**。它假设了 CLI 交互环境
- `webSearchPlugin`（自动加 web search tool）—— **算 harness 的中间层**。它假设了你需要联网

判定标准：**是否假设了运行环境或任务类型**。

### 灰区 2：`adapter-anthropic` 算哪层？

- 不是 framework（framework 只认 `ChatModel` 接口）
- 不是 harness（不内置 tools，不写 system prompt）
- **是 L1/L2 的兄弟层** —— 协议实现包，**横在 L1 旁边**，被 L3/L4 选用

按你 M2 实现，`adapter-anthropic` 是独立包，**framework 不依赖它，harness 依赖它**。这是对的。

### 灰区 3：`tools-common` 算哪层？

- 同 adapter-anthropic —— **独立包，被 harness 选用**
- 不在 framework 里，**framework 包绝不能 import tools-common**
- 一个用户可以只用 framework + 自己的 tools，根本不碰 tools-common

---

## 反模式（要警惕的）

| 反模式 | 问题 |
|---|---|
| Framework 内置 "default tools" | 污染了领域中性，把 framework 拖向 harness |
| Framework 内置 "default system prompt" | 同上，且把"agent 行为"耦合进装配层 |
| Harness 暴露 `Plugin` 让用户随便加 | 模糊了边界。Harness 应该是"成品"，暴露窄 API 即可 |
| Harness 之间互相依赖 | `harness-coding` 不应该依赖 `harness-chat`，它们是平行的成品 |

---

## 落到你项目的具体建议

**framework（M3）必须满足**：

- 包只依赖 `core`
- 零 system prompt 字符串
- 零 tool 实现
- 接受 `ChatModel` 接口，**不 import 任何具体 model 类**

**harness（M4 及以后）允许**：

- 依赖 `framework` + `adapter-anthropic` + `tools-common`
- 内置 system prompt
- 内置 tool 选择
- 对外暴露**窄而具体**的 API（`createCodingAgent` 而不是 `createAgent`）
- 一个 harness = 一种用法。需要不同行为？**做第二个 harness**，不要给一个 harness 加 mode 参数

**判断"该 fork 新 harness 还是给老 harness 加参数"的标准**：

如果两种用法的 **system prompt 和 tools 集合 ≥70% 重叠** → 加参数；否则 → 新 harness。
