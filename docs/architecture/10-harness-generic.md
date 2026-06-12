# Harness: Generic (File-driven)

通用 agent harness——行为由 **workspace 目录里几个 markdown 文件**控制，而非硬编码在 npm 包里。同一份 `harness-generic` 配不同 workspace = 不同领域 agent。

> 这是 [Harness 形态 B](./09-harness.md#两种形态) 的具体落地。Harness 三必要条件（domain-closed + zero-assembly + behavior-locked）全部成立，"领域"由 workspace 文件内容承载。

---

## 一、为什么不做 `harness-coding` / `harness-research` 等领域包

按 [Harness vs Framework §反模式](./11-harness-vs-framework.md#反模式) 的"≥70% 重叠 → 加参数"原则：

| 维度 | coding / research / writing 之间是否重叠 |
|---|---|
| 需要 `read` / `write` / `bash` / `grep` / `glob` tool | ≥ 95% 重叠 |
| 需要 fs-memory plugin | 100% 重叠 |
| 需要 progressive-skill plugin | 100% 重叠 |
| 需要 permission plugin | 100% 重叠 |
| 需要 bootstrap 读 SOUL/USER/TOOLS | 100% 重叠 |
| system prompt 内容 | **0% 重叠** — 这是唯一差异 |

唯一差异是 **system prompt 内容**。把这个差异塞进 npm 包等于每个领域复制粘贴 99% 相同的代码。**把差异挪到 workspace 文件**：

- coding agent = `harness-generic` + `templates/coding/SOUL.md`
- research agent = `harness-generic` + `templates/research/SOUL.md`

包数量从 N 收敛到 1，领域知识从代码变更变成文件编辑。

---

## 二、Workspace 文件 spec

```text
${workspace}/
├── AGENTS.md              # 主编排：session 流程、安全默认
├── SOUL.md                # agent 身份、语气、不可逾越的约束
├── USER.md                # 用户 profile
├── TOOLS.md               # 工具环境注记
├── MEMORY.md              # 长期事实根文件         ← fs-memory plugin 接管
├── facts/                 # 离散事实               ← fs-memory plugin 接管
├── memory/                # 日工作日志（按天）
│   └── YYYY-MM-DD.md      # 启动时由 harness 注入今天+昨天两份
└── skills/                # 渐进技能              ← progressive-skill plugin 接管
    └── ${skill}/SKILL.md
```

### 单个文件的责任

| 文件 | 内容 | 谁写 |
|---|---|---|
| `AGENTS.md` | session 流程指挥、安全默认、shared-space 行为约定 | 用户 |
| `SOUL.md` | "你是谁、你的语气、不可越界的约束" | 用户 |
| `USER.md` | 用户姓名、偏好、所属团队、常用项目 | 用户（**LLM 不写**） |
| `TOOLS.md` | 工具环境注记（PSM / devbox / 内部路径约定等） | 用户 |
| `MEMORY.md` | 长程事实（用户长期偏好、合规约束、世界观） | 用户起步，LLM 通过 `memory_write` 追加到 `facts/`；self-compact 为 future work（见 fs-memory §六） |
| `memory/YYYY-MM-DD.md` | 当天工作日志（LLM 自己记录今天干了什么） | LLM 通过通用 `write_file` 写 |

### 全部文件可缺失，缺失视为空段

任何文件不存在 = 该段在 systemPrompt 里为空字符串。harness 不强制任何文件必须存在——可以从一个空 workspace 跑起来，行为退化为"纯 fs-memory + progressive-skill 的 agent"。

> 这条与 [fs-memory MEMORY.md 缺失视为空](./06-plugin-fs-memory.md#九不做的事永久性技术契约) 一致。

### AGENTS.md 不是结构化配置

AGENTS.md 全文拼到 systemPrompt 末尾让 LLM 自己理解。harness **不解析**它为开关。需要结构化控制时通过显式入参（`permissionMode` 等）传，不通过 AGENTS.md 反射。

理由：

1. 不引入 yaml / frontmatter parser 依赖
2. AGENTS.md 是自由 prose，让用户写"如果用户开始抱怨，先共情再解决"这类无法用 yaml 表达的指令
3. 结构化开关一旦放进 markdown 会形成两套 source of truth（代码参数 + 文件配置），冲突难定位

---

## 三、Session start bootstrap

每次 `createGenericAgent(opts)` 调用执行 6 件事：

```ts
async function createGenericAgent(opts: GenericAgentOptions): Promise<Agent> {
  const ws = opts.workspace;

  // 1. 并发读 6 份文件（任意缺失视为空）
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = isoMinusOne(today);
  const [soul, user, tools, agents, todayLog, yestLog] = await Promise.all([
    readOrEmpty(`${ws}/SOUL.md`),
    readOrEmpty(`${ws}/USER.md`),
    readOrEmpty(`${ws}/TOOLS.md`),
    readOrEmpty(`${ws}/AGENTS.md`),
    readOrEmpty(`${ws}/memory/${today}.md`),
    readOrEmpty(`${ws}/memory/${yesterday}.md`),
  ]);

  // 2. 拼 systemPrompt 静态段
  const systemPrompt = composeSystemPrompt({
    workspace: ws, today, yesterday, soul, user, tools, agents, todayLog, yestLog,
  });

  // 3. 装配 framework
  return createAgent({
    model: opts.model,
    systemPrompt,
    tools: builtinTools(ws),
    plugins: [
      fsMemoryPlugin({ ws: ws, root: '/memory/' }),
      progressiveSkillPlugin({ dir: `/skills/` }),
      permissionPlugin({ mode: opts.permissionMode ?? 'ask' }),
    ],
    checkpointer: opts.checkpointer ?? inMemoryCheckpointer(),
    logger: opts.logger ?? consoleLogger(),
    threadId: opts.threadId,
    signal: opts.signal,
  });
}
```

### systemPrompt 拼装规则（6 段）

```
<workspace>
Root: ${workspace}
File tools (read, write, edit, grep, glob) use absolute paths relative to this root.
For bash, pass cwd='${workspace}' by default; override when the user explicitly requests a different directory.
Today: ${today}
</workspace>

<soul>
${soul}
</soul>

<user>
${user}
</user>

<tools>
${tools}
</tools>

<agents>
${agents}
</agents>

<recent-work>
## ${yesterday}
${yestLog}

## ${today}
${todayLog}
</recent-work>
```

空段保留标签外壳但内容为空（让 LLM 知道这是有意为空，不是漏掉）。

为防止 workspace 文件内容注入闭合标签破坏 prompt 结构，6 个 XML 标签名（`workspace/soul/user/tools/agents/recent-work`）的闭合标签在用户内容中被转义为 `<\\/tagname>`。

### 为什么 daily-log 在 bootstrap 一次性注入，不做 plugin

奥卡姆剃刀。详见 [09-harness.md §文件分工](./09-harness.md#文件分工) 的论证：daily-log 只在 session 启动时需要读一次，不需要 `beforeModel` hook，因此**不应**成为 plugin。LLM 写当天日志用通用 `write_file` tool 即可：

```
LLM 调 write_file({ path: 'memory/2026-06-05.md', content: '今天...', append: true })
```

---

## 四、内置 tools

`harness-generic` 装配以下 tool 套件（领域中立，所有 workspace agent 都需要）：

| Tool | 作用 | 路径约束 |
|---|---|---|
| `read` | 读 workspace 内文件 | 必须 `${workspace}/...` |
| `write` | 写 workspace 内文件 | 必须 `${workspace}/...`，支持 `append` 模式 |
| `bash` | 执行 shell 命令 | 默认 `cwd = workspace`，LLM 可按用户请求覆盖 |
| `grep` | 文件内搜索 | 限定 workspace 内 |
| `glob` | 文件 pattern 匹配 | 限定 workspace 内 |

**所有 tool 入参路径必须落在 workspace 内**（解析后 `resolve(p).startsWith(workspace)`）。越界请求转 `is_error: true` 的 tool_result，让 LLM 自己改正而非直接 throw。

这条契约与 [fs-memory](./06-plugin-fs-memory.md) 一致——plugin 内 tool 同样禁止越界。

---

## 五、模板分发（Templates）

不在 `harness-generic` 包里，独立目录或独立仓库：

```
templates/
├── coding/
│   ├── SOUL.md       # "你是严谨的工程师，写测试优先..."
│   ├── AGENTS.md     # "session 开始先读 README.md..."
│   ├── TOOLS.md      # "项目用 bun，不用 npm..."
│   └── MEMORY.md     # 空起步
├── research/
└── writing/
```

由 [Backend §POST /agents](./12-backend.md#post-agents) 在创建 agent 时复制到新 workspace。harness 不感知模板的存在——它只看见用户给的 workspace。

---

## 六、API

```ts
// @my-agent-team/harness-generic

import type { Agent, ChatModel, Checkpointer, Logger } from '@my-agent-team/framework';

export interface GenericAgentOptions {
  /** Workspace 根目录（绝对路径推荐）。所有 tool / plugin 的相对基准 */
  workspace: AgentFsHandle;

  /** 已构造好的 ChatModel 实例（adapter 由调用方选） */
  model: ChatModel;

  /** thread 标识。同 thread 复用 checkpointer 历史。默认随机 uuid */
  threadId?: string;

  /** AbortSignal。Backend / Runner 收到 abort 时停掉本次 run */
  signal?: AbortSignal;

  /** 权限模式。默认 'ask' */
  permissionMode?: 'ask' | 'auto' | 'deny';

  /** 注入式 logger / checkpointer，默认 console + in-memory */
  logger?: Logger;
  checkpointer?: Checkpointer;
}

export function createGenericAgent(opts: GenericAgentOptions): Agent;
```

### 调用方（本地裸跑）

```ts
import { createGenericAgent } from '@my-agent-team/harness-generic';
import { AnthropicChatModel } from '@my-agent-team/adapter-anthropic';

const agent = createGenericAgent({
  workspace: '/home/me/.my-agent/workspace',
  model: new AnthropicChatModel({ apiKey: process.env.ANTHROPIC_API_KEY }),
});

for await (const event of agent.run('add a unit test for utils.ts')) {
  console.log(event);
}
```

### 调用方（被 Backend Runner 装配）

```ts
// runner-daemon entry.ts
const spec = AgentSpecV1.parse(JSON.parse(process.env.AGENT_SPEC!));
const agent = createGenericAgent({
  workspace: spec.workspace,
  model: new AnthropicChatModel(spec.model),
  threadId: spec.threadId,
  permissionMode: spec.permissionMode,
});
for await (const ev of agent.run(spec.input)) {
  process.stdout.write(JSON.stringify(ev) + '\n');
}
```

harness API 在两种调用场景下**完全相同**——这是 [§与 Backend 的边界](./09-harness.md#与-backend-的边界) 自然推论。

---

## 七、与 Backend 的契约

`harness-generic` 必须支持以下 backend 使用模式：

1. **AbortSignal**：`opts.signal.abort()` 后，进行中的 run 在下一个 await 点（model call 或 tool 间）停止
2. **threadId 复用**：相同 threadId 调用 = 复用 checkpointer 历史；不同 threadId = 新会话
3. **logger / checkpointer 注入**：backend 想接 trace 系统 / 自定义 DB，从入参注入即可，不需要 fork harness
4. **`agent.run()` 返回 AsyncIterable**：backend runner 把 event 转任意 transport

→ harness **不主动**与 backend 通信。所有通信由 runner entry 负责。

---

## 八、设计自检对照（Harness 5 条 checklist）

按 [09-harness.md §判断 checklist](./09-harness.md#判断-checklist) 逐条对照：

1. README 写 "for users with a workspace" — ✅
2. 工厂函数签名没有 `tools` / `plugins` / `contextManager` — ✅（只有 `workspace` / `model` / 注入式 logger）
3. 行为变化来自参数 + workspace 文件，不来自 mode 开关 — ✅（仅 `permissionMode` 一个开关）
4. 不引入网络 / agentId / 沙箱概念 — ✅
5. 同样输入（同 workspace 同 input）行为稳定 — ✅（前提是 workspace 文件不变）

---

## 九、不做的事（永久性技术契约）

- **不读 `process.env`** — 配置走显式参数
- **不假设 `process.cwd()`** — 所有路径基于 `workspace`
- **不 mkdir workspace** — 调用方必须保证 workspace 已存在（backend 负责物化）
- **不维护模板** — 模板由 backend / 独立目录管
- **不解析 AGENTS.md 为结构化配置** — 全文拼到 systemPrompt
- **不让 LLM 自动改 USER.md** — USER.md 是用户档案，避免 LLM 把幻觉写进去；需要时 LLM 用通用 write_file 显式改
- **不引入 network/transport 依赖** — `node:http` / `ws` / `fetch` 全部禁止（model adapter 内部除外）
- **不认识 `agentId` / `租户` / `沙箱` / `HTTP`** — 这些是 backend 的概念
- **不内置 daily-log plugin** — daily-log 由 bootstrap 一次性读 + 通用 write_file 写，不需要 hook

---

## 十、Future work（v1 不实现）

- `templates/` 仓库与版本管理策略
- workspace 文件热重载（session 内编辑文件实时生效，目前 session-scoped）
- MEMORY.md self-compact（见 [fs-memory §六](./06-plugin-fs-memory.md#六memorymd-写入策略)）
- shared workspace 模式（多 agent 协作同一 workspace 的并发控制）

---

**Harness Generic 文档结束。** 上游依赖：[Framework](./02-framework.md) / [fs-memory](./06-plugin-fs-memory.md) / [progressive-skill](./07-plugin-progressive-skill.md)。下游消费：[Backend](./12-backend.md)。