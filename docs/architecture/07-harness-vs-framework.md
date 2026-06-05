# Framework vs Harness

**装配件 vs 成品。** 一个是给白板原料自己装，一个是装好了直接用。

---

## 一句话对比

| 维度 | Framework | Harness |
|---|---|---|
| 厨房 | 锅碗瓢盆 + 灶 | 一份做好的盖饭 |
| 汽车 | 发动机+底盘+方向盘 | 整车 |
| 前端 | React | Next.js |
| LangChain | `createAgent({model, tools})` | `createDeepAgent()` |
| Anthropic | `@anthropic-ai/sdk` | Claude Code CLI |

---

## 三条硬边界

### 1. 领域假设

- **Framework**：领域无关。不知道用户写代码、查数据、还是聊天
- **Harness**：领域强相关。`harness-coding` 假设写代码

**判定**：写死了 system prompt → Harness。

### 2. 内置 tools

- **Framework**：零内置 tool。tools 由调用方传入
- **Harness**：内置一组 tool 套件

**判定**：`package.json` 依赖 `tools-common` → Harness；只依赖 `core` → Framework。

### 3. API 形态

- **Framework**：`createAgent({ model, tools, plugins, ... })` — 至少 2 个装配参数
- **Harness**：`createCodingAgent({ workdir })` — 0~1 个业务参数

---

## 项目划分

```
L4 Harness     ← 成品。harness-coding, harness-research, ...
   ↑ depends on Framework + adapter + tools
L3 Framework   ← 装配套件。createAgent, Plugin, Checkpointer, ContextManager, Logger
   ↑ depends on core
L2 Runtime     ← run() loop
   ↑ depends on core
L1 Protocols   ← Message, ChatModel, Tool
```

**Framework 产出**（`@my-agent-team/framework`）：

- `createAgent` / `Agent` / `Thread`
- `Plugin` / `definePlugin` — 扩展点
- `Checkpointer` / `ContextManager` / `Logger` — 内化能力 + 默认实现
- **零 tool、零 system prompt、零具体 model 实例**

**Harness 产出**（`@my-agent-team/harness-*`）：

- 固化 model（如 `AnthropicChatModel`）
- 固化 tools（如 read / write / bash / grep / glob）
- 固化 system prompt
- 固化 plugins + checkpointer + contextManager
- 暴露窄而具体的 API

---

## 灰色地带

### Plugin 归属

| Plugin | 归属 | 理由 |
|---|---|---|
| `permissionPlugin` | **Harness** | 假设 CLI / 用户交互 UI |
| `webSearchPlugin` | **Harness** | 假设"需要联网"的任务场景 |
| `metricsPlugin` | **Framework 或 Harness** | 领域中立，但具体 sink（Prometheus/Sentry）可能偏 harness |

判定标准：**是否假设了运行环境或任务类型**。

### Adapter 归属

`@my-agent-team/adapter-anthropic` 不属于任一层 — 是 **协议实现包**，横在 L1 旁边，被 L3/L4 选用。Framework 不依赖它（只认 `ChatModel` 接口），Harness 依赖它。

### `tools-common` 归属

独立包，被 Harness 选用。Framework **绝不** import `tools-common`。用户可以用 Framework + 自己的 tools，完全不碰 `tools-common`。

---

## 反模式

| 反模式 | 为什么 |
|---|---|
| Framework 内置 default tools | 污染领域中性，把 Framework 拖向 Harness |
| Framework 内置 default system prompt | 同上 |
| Harness 暴露 `Plugin` 让用户随便加 | 模糊边界。成品应暴露窄 API |
| Harness 之间互相依赖 | `harness-coding` 不该依赖 `harness-chat`，平行成品 |
| 一个 Harness 加大量 mode 参数 | 应拆成多个 Harness。**≥70% 重叠 → 加参数；否则 → 新 Harness** |
