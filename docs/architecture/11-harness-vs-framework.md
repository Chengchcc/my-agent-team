# Framework vs Harness vs Backend

**装配件 vs 成品 vs 托管服务。** 三层分工，每层只解决一件事。

---

## 一句话对比

| 维度 | Framework | Harness | Backend |
|---|---|---|---|
| 厨房 | 锅碗瓢盆 + 灶 | 一份做好的盖饭 | 外卖平台 |
| 汽车 | 发动机+底盘+方向盘 | 整车 | 出租车公司 |
| 前端 | React | Next.js 模板 | Vercel |
| LangChain | `createAgent({model, tools})` | `createDeepAgent()` | LangSmith Serve |
| Anthropic | `@anthropic-ai/sdk` | Claude Code CLI | Claude.ai |

---

## 三条硬边界（Framework vs Harness）

### 1. 领域假设

- **Framework**：领域无关。不知道用户写代码、查数据、还是聊天
- **Harness**：领域强相关。`harness-generic` 假设"用户在 workspace 目录里干活"；具体领域由 workspace 文件内容决定

**判定**：调用方需要传 `model` 或 `tools` → Framework；只传 `workspace` / 业务参数 → Harness。

### 2. 内置 tools

- **Framework**：零内置 tool。tools 由调用方传入
- **Harness**：内置一组 tool 套件（read / write / bash / grep / glob）

**判定**：`package.json` 依赖 `tools-common` → Harness；只依赖 `core` → Framework。

### 3. API 形态

- **Framework**：`createAgent({ model, tools, plugins, ... })` — 至少 2 个装配参数
- **Harness**：`createGenericAgent({ workspace, model })` — 0~2 个业务参数

---

## Harness vs Backend 边界

| 维度 | Harness | Backend |
|---|---|---|
| 形态 | 库（函数） | 进程（常驻服务） |
| 生命周期 | 一次 run = 一个 agent 实例 | 长期运行，多 agent 并存 |
| 知道的事 | workspace 路径、threadId、model | agentId、租户、沙箱、HTTP、配额、workspace 物化 |
| 不知道的事 | agentId、HTTP、沙箱、租户 | message 拼接、tool 调度、plugin hook |
| 调用关系 | 被 backend 的 runner entry 装配 | 装配 harness 并对外暴露 HTTP/SSE |

**切线**：**workspace 路径 + threadId** 是 backend ↔ harness 唯一的传递点。详见 [09-harness.md §与 Backend 的边界](./09-harness.md#与-backend-的边界)。

---

## 项目划分

```
L5 Backend     ← 常驻服务。agentId 表 + workspace 物化 + HTTP/SSE + 鉴权 + runner
   ↑ depends on Harness（Framework 通过 harness 间接消费）
L4 Harness     ← 成品。harness-generic（file-driven）
   ↑ depends on Framework + adapter + tools + plugins
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

**Harness 产出**（`@my-agent-team/harness-generic`）：

- 不固化 model（由调用方传 ChatModel 实例，便于 backend 注入不同 baseURL）
- 固化 tools（read / write / bash / grep / glob 等通用 workspace 工具）
- 固化 plugin 编排（fs-memory + progressive-skill + permission）
- 不固化 system prompt — 由 workspace 文件拼装而成
- 暴露窄而具体的 API（`workspace` 必传，其余可选）

**Backend 产出**（`@my-agent-team/backend` + `apps/backend`）：

- HTTP server + SSE streaming
- agentId → AgentSpec 映射 + 持久化
- workspace 生命周期（mkdir、模板初始化、归档）
- runner entry（同进程 / 子进程 stdio / HTTP / WebSocket）
- 鉴权 + 多租户 + 配额

---

## 灰色地带

### Plugin 归属

| Plugin | 归属 | 理由 |
|---|---|---|
| `fsMemoryPlugin` | **Framework 周边**（独立包） | 领域中立。任何 harness 都可能用 |
| `progressiveSkillPlugin` | **Framework 周边**（独立包） | 同上 |
| `permissionPlugin` | **Harness** | 假设有人机交互界面 |
| `metricsPlugin` | **Backend** | 假设有运行时上下文（agentId、租户） |

判定标准：**是否假设了运行环境或调用者身份**。

### Adapter 归属

`@my-agent-team/adapter-anthropic` 不属于任一层 — 是 **协议实现包**，横在 L1 旁边，被 Backend 或调用方选用并构造 model 实例后传入 Harness。Framework 不依赖它（只认 `ChatModel` 接口）。

### `tools-common` 归属

独立包，被 Harness 选用。Framework **绝不** import `tools-common`。

### Runner 归属

Runner 是 backend 提供的**进程入口**（≤ 50 行的 entry script），把 harness 包成具体 transport（stdio / HTTP / WebSocket）。属于 Backend 层。Harness **绝不感知 transport**。

---

## 反模式

| 反模式 | 为什么 |
|---|---|
| Framework 内置 default tools | 污染领域中性 |
| Framework 内置 default system prompt | 同上 |
| Harness 暴露 `Plugin[]` 让用户随便加 | 模糊边界。成品应暴露窄 API |
| Harness 引入 `node:http` / `ws` 依赖 | 把 transport 责任泄漏到装配层 |
| Harness 认识 `agentId` 或 `租户` | 绑死特定 backend 的元数据模型 |
| Backend 直接 import `runtime` 跑 `run()` | 跳过 harness 层，丢失 plugin/checkpointer 编排 |
| 一个 Harness 加大量 mode 参数 | 应改成 workspace 文件控制；或拆多个 harness。**≥70% 重叠 → 加参数；否则 → 新 Harness** |
| `harness-coding` / `harness-research` 等领域包 | 在 file-driven 形态下应该是 `templates/coding/`、`templates/research/` 而非 npm 包 |
