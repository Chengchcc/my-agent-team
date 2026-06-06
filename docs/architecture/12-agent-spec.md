# AgentSpec — Backend ↔ Runner Wire Schema

定义 Backend 把"一次 agent 运行"喂给 Runner 时的契约对象。一个独立的 zod schema 包，**双向 validate**，带 `schemaVersion` 字段防止跨进程版本错配。

---

## 一、为什么独立成包

如果 AgentSpec 内嵌在 backend 包里、runner 复制粘贴 type：

| 失败 | 触发场景 |
|---|---|
| **schema drift** | backend 加字段，runner 实现没同步 → 反序列化丢字段或 parse 失败 |
| **版本不一致检测不到** | backend v1.3 vs runner v1.1 — bug 表现成"功能不生效"，不显式报错 |
| **第三方 runner 难维护** | 沙箱 vendor 写自己的 runner（wasm runtime / firecracker rootfs），要从 backend 抠 type 出来 |
| **跨语言不可共享** | runner 用 Go/Rust/Python 时没法 import TS type |

→ schema 是 **backend ↔ runner 之间的契约**。契约必须独立于任一方。

成本：一个零运行时逻辑、纯 type + zod 的包。治理成本极低。

---

## 二、Schema 定义

```ts
// packages/agent-spec/src/index.ts
import { z } from 'zod';

export const AgentSpecV1 = z.object({
  /** Schema 版本。runner 收到不匹配版本 hard fail */
  schemaVersion: z.literal('1'),

  /** Workspace 路径（runner 视角，可能是沙箱内的 /workspace） */
  workspace: z.string(),

  /** Thread 标识 */
  threadId: z.string(),

  /** Model 配置 */
  model: z.object({
    provider: z.literal('anthropic'),
    model: z.string(),
    baseURL: z.string().optional(),
  }),

  /** 鉴权。可选——也可由 runner 从 env 读 */
  apiKey: z.string().optional(),

  /** 权限模式。默认 'ask' */
  permissionMode: z.enum(['ask', 'auto', 'deny']).optional(),

  /** 本次 run 的用户输入（mode='run' 时必需；mode='resume' 时忽略） */
  input: z.string(),

  /** 逻辑 run 标识。一个 run 跨多次 interrupt/resume，所有 attempt 共享同一 runId */
  runId: z.string().optional(),

  /**
   * 执行模式。
   * - 'run'（默认）：agent.run(input) 起新执行
   * - 'resume'：agent.resume(resumeCommand) 续跑被中断的 run。
   *   backend 不 resume，而是 fork 一个新 attempt 子进程并标 mode='resume'；
   *   子进程内 checkpointer.consumeInterrupt 取回 pending interrupt（backend 不碰 checkpointer）。
   */
  mode: z.enum(['run', 'resume']).optional(),

  /** mode='resume' 时携带用户决策（framework 的 ResumeCommand） */
  resumeCommand: z.object({
    approved: z.boolean(),
    message: z.string().optional(),
  }).optional(),

  /**
   * 持久层连接配置。run 子进程据此**自行构造** EventLog / Checkpointer
   * adapter —— 跨进程传不了 handle,只能传连接配置(铁律:存储细节封死在 adapter)。
   * - eventLog:子进程 append 事件的事实源。**由 backend 下发并收敛**到 backend
   *   也能连的同一后端存储(不变量),否则 backend 投影端 subscribe 找不到事件。
   * - checkpointer:子进程 agent-resume 专用快照层。**可由 runner 异构选择**,backend
   *   既不持有也不读其内容(对 checkpointer 介质永久无感)。
   */
  storage: z.object({
    eventLog: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('postgres'), url: z.string() }),
      z.object({ kind: z.literal('sqlite'), path: z.string() }),
    ]),
    checkpointer: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('sqlite'), path: z.string() }),
      z.object({ kind: z.literal('file'), dir: z.string() }),
      z.object({ kind: z.literal('memory') }),
    ]),
  }).optional(),
});

export type AgentSpec = z.infer<typeof AgentSpecV1>;

export const CURRENT_SCHEMA_VERSION = '1' as const;
```

### Backend 侧用法

```ts
import { AgentSpecV1, CURRENT_SCHEMA_VERSION } from '@my-agent-team/agent-spec';

const spec = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  workspace: '/workspace',
  threadId: 't-42',
  model: { provider: 'anthropic', model: 'claude-sonnet-4' },
  permissionMode: 'ask',
  input: userInput,
} satisfies AgentSpec;

AgentSpecV1.parse(spec);                       // 发出前 validate，防自己写错
await transport.send(JSON.stringify(spec));
```

### Runner 侧用法

```ts
import { AgentSpecV1 } from '@my-agent-team/agent-spec';

const raw = JSON.parse(await readStdin());
const spec = AgentSpecV1.parse(raw);           // 收到后 validate，防 backend 错或版本错配

const agent = createGenericAgent({
  workspace: spec.workspace,
  model: new AnthropicChatModel({ apiKey: spec.apiKey ?? process.env.ANTHROPIC_API_KEY, ...spec.model }),
  threadId: spec.threadId,
  permissionMode: spec.permissionMode,
});
```

**双向 validate** = schema 变化要么编译失败（type drift），要么运行时立即报错（version 错配），**没有 silent drift**。

> **`storage` / `mode` / `resumeCommand` 字段**:durable runs 要求 run 子进程**独立于 backend 存活并直写持久层**。但进程间传不了已打开的 DB handle,所以 AgentSpec 携带**连接配置**(`postgres url` / `sqlite path`),子进程收到后**自行构造** EventLog / Checkpointer adapter——存储细节封死在 adapter,wire schema 只传"怎么连",不传"连好的对象"。
>
> 两条不变量:
> - **EventLog 收敛**:`storage.eventLog` 由 **backend 下发**,所有 runner 收敛到 backend 也能连的同一存储——否则 backend 投影端 `subscribe` 找不到事件。
> - **Checkpointer 可异构**:`storage.checkpointer` 由 runner 策略自由选择,backend 不持有、不读其内容。
>
> **resume 经 re-fork**:backend 不调 `agent.resume()`(它不持有 checkpointer)。它 fork 一个**新 attempt 子进程**,spec 带 `mode='resume'` + `resumeCommand` + 原 run 的 `runId` 与 `storage.checkpointer`;子进程内 `agent.resume()` 调 `checkpointer.consumeInterrupt` 取回 pending interrupt 续跑,事件继续 `append` 到同 `runId` 的 EventLog——前端 SSE 流无缝连续。详见 [11-backend §Resume](./11-backend.md#resumebackend-不-resume而是重新-fork-一个-attempt)。

---

## 三、版本演进策略

### 加字段（前向兼容，常见情况）

`schemaVersion` 仍是 `'1'`，新字段加 `.optional()`：

```ts
export const AgentSpecV1 = z.object({
  schemaVersion: z.literal('1'),
  workspace: z.string(),
  // ...
  // 新增字段
  quotaConfig: z.object({ maxTokens: z.number() }).optional(),
});
```

老 runner（用旧版包）收到 v1 spec 时多出的 `quotaConfig` 字段被 zod 忽略（默认 strip 模式），行为不变。日常加字段都走这条。

### 破坏性变更（改字段语义 / 删字段 / 改类型）

bump 到 `schemaVersion: '2'`，包同时 export `AgentSpecV1` 和 `AgentSpecV2`：

```ts
export const AgentSpecV2 = z.object({
  schemaVersion: z.literal('2'),
  // ... 新结构
});

export const AgentSpec = z.discriminatedUnion('schemaVersion', [
  AgentSpecV1,
  AgentSpecV2,
]);
```

老 runner 收到 `schemaVersion: '2'` 立即 hard fail（discriminated union 不匹配），返回明确错误："runner version too old, upgrade to >= x.y"。**不静默降级**。

### Deprecation 流程

1. 引入 V2，V1 继续可用，标 `@deprecated`
2. backend 默认发 V2，旧 runner 报错 → 强制升级
3. 一个 release cycle 后从包里移除 V1

---

## 四、Harness 不依赖此包

`harness-generic` 入参是**解构后的字段**（`workspace`、`threadId`、`model` 实例...），不是 `AgentSpec` 整体对象：

```ts
// ✗ 反模式：harness 入参用 AgentSpec
createGenericAgent(spec: AgentSpec)

// ✓ 正确：harness 接散字段，runner entry 负责拆包
createGenericAgent({ workspace, model, threadId, ... })
```

理由：

1. harness 不应该知道 wire schema 的版本概念
2. 本地裸跑（无 backend）时不需要构造 spec 对象
3. harness API 比 wire schema 演进慢，解耦后两者独立升级

→ **依赖图**：

```
backend ──┐
          ├──→ agent-spec
runner ───┘

backend ──→ harness-generic
runner ───→ harness-generic
harness-generic ✗→ agent-spec       (NOT depends)
```

---

## 五、跨语言场景（Future work）

当 runner 用 Go/Rust/Python 写（沙箱 supervisor 常见）：

- zod schema 作为 source of truth → 用 `zod-to-json-schema` 生成 JSON Schema
- 各语言用 `quicktype` / `datamodel-code-generator` 等工具 codegen
- 或换 Protobuf（更严格，但要重写 schema）

**当前暂时不需要** — 所有 runner 都跑在 Node/Bun。YAGNI。等真出现外部 runner 再升级。

---

## 六、包结构

```
packages/agent-spec/
├── src/
│   └── index.ts            # zod schema + type 导出
├── package.json
└── tsconfig.json
```

`package.json`：

```json
{
  "name": "@my-agent-team/agent-spec",
  "dependencies": {
    "zod": "^3.x"
  }
}
```

零业务逻辑，只有 schema 定义。

---

## 七、设计自检

| 问题 | 回答 |
|---|---|
| 为什么不放 `core` 包？ | `core` 是 L1 协议（Message/Tool/ChatModel）。AgentSpec 是 L5 wire format，跟 L1 协议不在一个抽象层 |
| 为什么不放 `backend` 包？ | schema 是双方契约，独立成包让 runner（特别是第三方 runner）不强依赖 backend |
| 为什么不放 `harness-generic` 包？ | harness 不感知 wire schema，依赖反了 |
| 为什么要 zod 不用 TS interface？ | TS 只编译时校验，跨进程必须运行时校验 + 错误信息友好 |
| 为什么不省 `schemaVersion` 字段？ | type 校验过 ≠ 版本一致；跨进程 / 跨发布周期需要显式 version handshake |

---

## 八、不做的事（永久性技术契约）

- **不放业务逻辑** — 包内零 runtime code，只有 schema + type
- **不依赖任何下游包**（`core` / `framework` / `harness-*` / `backend`） — 反向依赖会导致循环
- **不内置 transport** — 怎么把 spec 送达 runner 是 backend 的事（stdio / HTTP / WS），spec 包只管 schema
- **不内置 secret 管理** — `apiKey` 是普通字段，加密 / 注入由 backend 处理
- **不内置环境变量解析** — 不读 `process.env`，不替换 `${VAR}` 占位符

---

**AgentSpec 文档结束。** 上游消费：[Backend](./11-backend.md) / Runner 包。