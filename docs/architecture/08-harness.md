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
| **Domain-closed** | 对"用户要做什么"有具体假设。`harness-generic` 假设"用户在 workspace 目录里干活" |
| **Zero-assembly** | 用户不需要懂 Framework。API 参数是业务概念（`workspace`），不是装配概念（`model`、`tools`、`plugins`） |
| **Behavior-locked** | 同一 harness 行为稳定可预期。升级版本是唯一变更来源。不暴露大量 mode 开关 |

---

## 两种形态

Harness 有两条可选实现路径。两条都满足三必要条件，差别在"领域知识住在哪"。

### 形态 A：Code-driven（早期文档默认形态）

system prompt、tool 选型、plugin 预设全部**写死在 npm 包里**。每个领域一个 harness 包：`harness-coding`、`harness-research`、`harness-writing`...

```
harness-X/
├── system-prompt.ts      # 写死的 prompt
├── tools/                # 该领域的 tool 集合
├── model-selection.ts    # 选用的 adapter
├── plugin-preset.ts      # 选用的 plugins
└── index.ts              # 工厂函数
```

**适合**：领域固定、用户量大、希望零配置就跑。

### 形态 B：File-driven（推荐形态，本项目采用）

system prompt 和领域约束**不在代码里**，而在用户的 **workspace 目录**里——几个 markdown 文件控制 agent 行为：

```text
${workspace}/
├── AGENTS.md              # 主编排：session 流程、安全默认
├── SOUL.md                # agent 身份、语气、不可逾越的约束
├── USER.md                # 用户 profile
├── TOOLS.md               # 工具环境注记
├── MEMORY.md              # 长期事实根文件         ← fs-memory plugin 接管
├── facts/                 # 离散事实               ← fs-memory plugin 接管
├── memory/                # 日工作日志（按天）     ← harness bootstrap 启动时一次性 read
│   └── YYYY-MM-DD.md
└── skills/                # 渐进技能              ← progressive-skill plugin 接管
```

**领域 = workspace 文件内容**。同一份 `harness-generic` 包，配 coding 风格的 SOUL/AGENTS → 是 coding agent；配 writing 风格 → 是写作 agent。

**为什么这么做**：

1. 不同领域之间 ≥ 80% 重叠（都需要 memory、skills、permission、bootstrap）— 按 [Framework vs Harness §反模式](./10-harness-vs-framework.md) 的"≥70% 重叠 → 加参数"原则，应合并而非平行
2. 领域知识演化频率 ≫ 代码演化频率 — 用户改 prompt 不应该需要发 npm 版本
3. 模板可以分发（`templates/coding/`、`templates/research/`），仍然是"零装配"

**不适合**：希望 LLM 行为完全锁死、绝不允许用户改 prompt 的场景（那种用形态 A）。

> 本仓库实现的 `harness-generic` 是形态 B。本文档余下小节均以 B 为主，但 A 的三必要条件仍然适用。

---

## 文件分工

Workspace 7 类文件，按"读频次 + 是否需要 hook"分给三个责任方：

| 文件 | 责任方 | 注入时机 |
|---|---|---|
| `AGENTS.md` | **harness bootstrap** | session 启动一次 |
| `SOUL.md` | **harness bootstrap** | session 启动一次 |
| `USER.md` | **harness bootstrap** | session 启动一次 |
| `TOOLS.md` | **harness bootstrap** | session 启动一次 |
| `memory/YYYY-MM-DD.md`（今天+昨天） | **harness bootstrap** | session 启动一次 |
| `MEMORY.md` + `facts/` | [`fsMemoryPlugin`](./06-plugin-fs-memory.md) | 每轮 `beforeModel` |
| `skills/*/SKILL.md` | [`progressiveSkillPlugin`](./07-plugin-progressive-skill.md) | 每轮 `beforeModel` + lazy load tool |

### 为什么 SOUL/USER/TOOLS/AGENTS/daily-log 不是 plugin

按 [Plugin 设计自检 #1](./03-plugin.md#设计自检-checklist)："它真的需要看 agent 内部执行节点吗?"

这 5 类文件只在 **session 启动**时读一次拼进 systemPrompt，session 内不再变化（变化只发生在用户编辑文件 + 起新 session）。它们不需要 hook，因此不应是 plugin——做成 plugin 会违反 plugin 的存在性论证。

### 为什么 MEMORY.md 和 skills 是 plugin

- MEMORY.md 必须**每轮**注入：用户长程偏好任何时候都要在 context 里
- skills 索引每轮注入 + lazy load 通过 tool 触发

这两者机制差异是真的（每轮 vs 启动一次），所以独立成 plugin 有理。daily-log 看起来像 memory，但它是 session-scoped 的工作记忆，启动时拼一次足够，因此**不另起 plugin**——奥卡姆剃刀。

---

## Session start bootstrap 协议

每个新 session（= 新 thread）启动时，harness 工厂按固定顺序完成 6 件事：

```ts
async function createGenericAgent(opts: GenericAgentOptions): Promise<Agent> {
  const ws = opts.workspace;
  const today = todayIso();
  const yesterday = isoMinusOne(today);

  // 1. 读 workspace 静态文件
  const [soul, user, tools, agents, todayLog, yestLog] = await Promise.all([
    readOrEmpty(`${ws}/SOUL.md`),
    readOrEmpty(`${ws}/USER.md`),
    readOrEmpty(`${ws}/TOOLS.md`),
    readOrEmpty(`${ws}/AGENTS.md`),
    readOrEmpty(`${ws}/memory/${today}.md`),
    readOrEmpty(`${ws}/memory/${yesterday}.md`),
  ]);

  // 2. 拼 systemPrompt（静态段，本 session 内不变）
  const systemPrompt = composeSystemPrompt({ soul, user, tools, agents, todayLog, yestLog });

  // 3. 装配 framework
  return createAgent({
    model: opts.model,
    systemPrompt,
    tools: builtinTools(ws),                         // read/write/bash/grep/glob
    plugins: [
      fsMemoryPlugin({ dir: ws }),                   // MEMORY.md + facts/
      progressiveSkillPlugin({ dir: `${ws}/skills` }),
      permissionPlugin({ mode: opts.permissionMode ?? 'ask' }),
    ],
    checkpointer: opts.checkpointer ?? inMemoryCheckpointer(),
    logger: opts.logger ?? consoleLogger(),
    threadId: opts.threadId,
    signal: opts.signal,
  });
}
```

**顺序保证**：

1. systemPrompt 静态段（来自 SOUL/USER/TOOLS/AGENTS/daily-log，harness 拼）
2. 每轮 `beforeModel` 注入段（来自 fs-memory / progressive-skill plugin）

两者职责清晰不重叠：静态段 = "agent 是谁、用户是谁、今天昨天发生了什么"，注入段 = "长程事实 + 当前可用技能"。

---

## 与 Backend 的边界

> harness 完全不认识 `agentId`、`租户`、`沙箱`、`HTTP`。它的全部输入是
> `workspace 路径 + apiKey + threadId + 注入式 logger/checkpointer + signal`。

### 谁负责什么

| 步骤 | 谁做 |
|---|---|
| 创建 `agentId` 并存元数据 | [Backend](./11-backend.md) |
| 查 `agentId → AgentSpec`（workspace 路径、模型、权限模式...） | Backend |
| 物化 workspace 目录（mkdir、首次从 template 复制 SOUL/AGENTS 等） | Backend |
| 决定部署形态（同进程 / 沙箱进程 / 远端 HTTP） | Backend |
| 读 SOUL/USER/TOOLS/AGENTS/daily-log 拼 systemPrompt | **Harness** |
| 启动 fs-memory / progressive-skill plugin | **Harness** |
| 跑 agent loop、调 model、跑 tool | **Harness**（其底下的 framework） |
| 推 SSE / 鉴权 / 配额 / tracing | Backend |

**切线**：**workspace 路径**是 backend ↔ harness 的唯一传递点。backend 一切按 agentId，harness 一切按 workspace，中间靠这条字符串隔离。

### 为什么 harness 不能认识 agentId

如果 harness 知道 `agentId`：

1. harness 必须知道 `agentId → workspace` 的映射 → 被绑死在某个 backend 的元数据模型
2. 本地开发跑不了 — `bun test` 时没有 backend，要 mock agentId
3. 多租户 / 多 backend 形态下 agentId 语义会冲突

这违反 "Domain-closed + Zero-assembly"——`workspace` 是业务概念，`agentId` 是装配/调度概念。

### 为什么 harness 不能认识沙箱

沙箱是**进程层面**的隔离（fs / 网络 / PID 已被 OS frozen），harness 是进程里的代码，看到的只是"路径、能力、错误"。把"沙箱"概念塞进 harness API：

1. 本地裸跑必须 mock sandbox
2. 沙箱实现（firecracker / gvisor / wasm）替换时 harness 要改
3. "申请沙箱资源 / 决定沙箱配置"是调度决策，不属于装配成品

→ harness 通过 `workspace 路径 + apiKey + 环境变量`这套标准接口被沙箱**透明**套住，0 改动。

### 通信由 Backend 的 runner 适配

harness 暴露的 I/O 形态是：

```ts
const agent = createGenericAgent({ workspace, threadId, signal, ... });
for await (const event of agent.run(userInput)) {
  // event = AgentEvent (text / tool_use / tool_result / interrupted / done)
}
```

backend 包外面写一个 **runner entry**（≤ 50 行），把 event 序列化成具体 transport：

| Transport | 场景 | runner 形态 |
|---|---|---|
| 同进程函数调用 | 本地 dev / 单体部署 | 直接 `for await` |
| 子进程 stdio | 本机沙箱 | `process.stdout.write(JSON.stringify(event) + '\n')` |
| HTTP SSE | 远端常驻服务 | `res.write('event: ${type}\ndata: ${json}\n\n')` |
| WebSocket | 双向（中断、人工 approve） | `ws.send(event)` + `ws.onMessage → signal.abort()` |

harness 包**永远不引入任何网络/transport 依赖**。详见 [11-backend.md §跨进程隔离](./11-backend.md#跨进程隔离--通过-runner-透明套上)。

---

## API

```ts
// @my-agent-team/harness-generic

export interface GenericAgentOptions {
  /** Workspace 根目录。所有文件读写的相对基准 */
  workspace: string;

  /** 已构造好的 ChatModel 实例（adapter 由调用方选） */
  model: ChatModel;

  /** thread 标识。同 thread 会复用 checkpointer 的历史 */
  threadId?: string;

  /** AbortSignal。Backend 收到 abort 时停掉本次 run */
  signal?: AbortSignal;

  /** 权限模式。默认 'ask' */
  permissionMode?: 'ask' | 'auto' | 'deny';

  /** 注入式 logger / checkpointer，默认 console + in-memory */
  logger?: Logger;
  checkpointer?: Checkpointer;
}

export function createGenericAgent(opts: GenericAgentOptions): Agent;
```

调用方：

```ts
import { createGenericAgent } from '@my-agent-team/harness-generic';
import { AnthropicChatModel } from '@my-agent-team/adapter-anthropic';

const agent = createGenericAgent({
  workspace: '/var/agents/abc/workspace',
  model: new AnthropicChatModel({ apiKey: process.env.ANTHROPIC_API_KEY }),
  threadId: 'thread-42',
});

for await (const event of agent.run('add a unit test for utils.ts')) {
  console.log(event);
}
```

**用户输入只有业务参数**（workspace + threadId + model），不需要懂 plugin / contextManager / checkpointer 的存在。

---

## 不做的事（永久性技术契约）

- **harness 不读 `process.env`** — 所有配置走显式参数。环境变量解析是 backend / runner entry 的事
- **harness 不假设 `process.cwd()`** — 所有路径基于 `workspace`
- **harness 不假设特定挂载点**（如 `/tmp`、`/home`）— 临时文件落 `${workspace}/.tmp` 或显式参数
- **harness 不 spawn 子进程做装配** — `bash` tool 是用户行为，不是装配行为。沙箱限制子进程不影响 harness 启动
- **harness 不引入网络/transport 依赖** — 不 import `node:http`、不 import `ws`、不调 `fetch`（除 model adapter 内部）
- **harness 不认识 agentId / 租户 / 沙箱 / HTTP** — 这些都是 backend 的概念
- **harness 不维护 workspace 模板** — 模板分发由 backend 或独立 `templates/` 仓库做
- **harness 不解析 AGENTS.md 为结构化配置** — AGENTS.md 是自由 markdown，全文拼到 systemPrompt 让 LLM 自己理解。需要结构化开关时通过 `permissionMode` 等显式入参传

这套契约的核心目的：**保证 harness 在任意部署形态下（本地 / 容器 / firecracker / wasm / 跨网络）都能不修改一行代码跑起来**。

---

## Harness 不是什么

| 不是 | 区别 |
|---|---|
| **Framework** | Framework 是装配套件，Harness 是装配成品 |
| **Adapter** | Adapter 只翻译 model API，不写 prompt、不选 tool |
| **Tool 包** | Tool 包提供能力，Harness 决定用哪些能力做什么任务 |
| **Plugin** | Plugin 是 Framework 的扩展点，Harness 是消费者 |
| **Backend** | Backend 是常驻服务（多 agent + HTTP + 鉴权），Harness 是单 agent 装配函数 |
| **Runner** | Runner 是 backend 提供的进程入口（包 harness + transport），Harness 是 runner 内被装配的对象 |
| **CLI** | CLI 可能基于 Harness 构建，但 Harness 本身是库 |
| **multi-agent** | Harness 是单 agent 成品 |

---

## 判断 checklist

| # | 问题 | → 是 Harness |
|---|---|---|
| 1 | README 里能写 "for X tasks" 或 "for users with a workspace"? | 能 |
| 2 | 工厂函数签名里没有 `tools` / `plugins` / `contextManager`? | 没有 |
| 3 | 行为变化来自参数 + workspace 文件，不来自 mode 开关? | 是 |
| 4 | 不引入网络 / agentId / 沙箱概念? | 是 |
| 5 | 同样输入（同 workspace 同 input）行为稳定? | 稳定 |

5 条全中 → Harness。

---

## 总结

**Harness = Framework + 确定的选型（model + tools + plugins）+ 一个领域定语**。

形态 A 把领域写在代码里；**形态 B（本项目采用）把领域写在 workspace 文件里**——同一个 `harness-generic` 包配不同 workspace = 不同领域 agent。

存在价值：让不懂 Framework 的用户也能享用 Framework 的能力。**通过牺牲灵活性换取易用性**。

判断标准：**领域闭合 + 零装配 + 行为固化**，三条缺一不可；外加 5 条不做的事保证可在任意部署形态下运行。

具体实现见 [09-harness-generic.md](./09-harness-generic.md)。