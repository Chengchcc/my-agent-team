# AgentSpec — Backend ↔ Runner Wire Schema

定义 Backend 把"一次 agent 运行"喂给 Runner 时的契约对象。一个独立的 zod schema 包，**双向 validate**，带 `schemaVersion` 字段防止跨进程版本错配。

---

## 一、为什么独立成包

如果 AgentSpec 内嵌在 backend 包里、runner 复制粘贴 type：

| 失败 | 触发场景 |
|---|---|
| **schema drift** | backend 加字段，runner 实现没同步 → 反序列化丢字段或 parse 失败 |
| **版本不一致检测不到** | backend v2 vs runner v1 — bug 表现成"功能不生效"，不显式报错 |
| **第三方 runner 难维护** | 沙箱 vendor 写自己的 runner，要从 backend 抠 type 出来 |

→ schema 是 **backend ↔ runner 之间的契约**。契约必须独立于任一方。

---

## 二、Schema 定义

这把 AgentSpec 从扁平 `z.object` + `superRefine` 升级为 `z.discriminatedUnion("mode")`——互斥字段关系编码进类型，下游不用 `as` 断言。

```ts
// packages/agent-spec/src/index.ts
import { z } from 'zod';

const Model = z.object({
  provider: z.literal("anthropic"),
  model: z.string().min(1),
  baseURL: z.string().url().optional(),
});

const V2Common = {
  schemaVersion: z.literal("2"),
  agentId: z.string().min(1),
  runId: z.string().min(1),
  threadId: z.string().min(1),
  model: Model,
  permissionMode: z.enum(["ask", "auto", "deny"]).optional(),
  maxSteps: z.number().int().positive().optional(),
  conversationId: z.string().min(1).optional(),
  senderMemberId: z.string().min(1).optional(),
};

export const AgentSpecV2 = z.discriminatedUnion("mode", [
  z.object({ ...V2Common, mode: z.literal("run"),    input: z.string() }),
  z.object({ ...V2Common, mode: z.literal("resume"), resumeCommand:
    z.object({ approved: z.boolean(), message: z.string().optional() }) }),
  z.object({ ...V2Common, mode: z.literal("reflect"), input: z.string(),
    parentRunId: z.string().min(1) }),
]);

export type AgentSpecV2 = z.infer<typeof AgentSpecV2>;
export type AgentSpecV2Run     = Extract<AgentSpecV2, { mode: "run" }>;
export type AgentSpecV2Resume  = Extract<AgentSpecV2, { mode: "resume" }>;
export type AgentSpecV2Reflect = Extract<AgentSpecV2, { mode: "reflect" }>;
```

### 三种模式

| mode | 必填字段 | 语义 |
|------|---------|------|
| `"run"` | `input` | 启动新 agent loop |
| `"resume"` | `resumeCommand` | 从中断恢复，携带用户决策 |
| `"reflect"` | `input` + `parentRunId` | 反思 run，附加到父 run 后 |

### 关键变更（V1 → V2）

| 变更 | 原因 |
|------|------|
| `workspace` 字段删除 | daemon 自己持有 `AgentFsHandle`，不从 wire 传路径 |
| `agentId` 必填 | daemon 用其校验身份 + registry 用其寻址 endpoint |
| `model` 必填（无默认值） | daemon 不再兜底 `"claude-sonnet-4-6"`，model 由 backend builder 从 agent 配置读取 |
| `storage` 删除 | checkpointer 是 daemon-local SQLite，不经过 wire |
| `mode` 无 `.default()` | 判别联合要求显式 mode，builder 总要写 |
| `mode="reflect"` 新增 | daemon 收到 `run_finalized` 后自主启动反思 |

### V1（保留，向后兼容）

```ts
export const AgentSpecV1 = z.object({
  schemaVersion: z.literal('1'),
  workspace: z.string(),
  threadId: z.string(),
  model: z.object({ provider: z.literal('anthropic'), model: z.string(), baseURL: z.string().optional() }),
  apiKey: z.string().optional(),
  permissionMode: z.enum(['ask', 'auto', 'deny']).optional(),
  input: z.string(),
  runId: z.string().optional(),
  mode: z.enum(['run', 'resume']).optional(),
  resumeCommand: z.object({ approved: z.boolean(), message: z.string().optional() }).optional(),
  storage: z.object({ /* eventLog + checkpointer */ }).optional(),
});
```

---

## 三、Backend → spec builder

builder 从 agent 配置读取 model/permission/maxSteps，三种模式复用：

```ts
async function buildAgentSpecV2(threadId: string, input: string, overrides?: {
  runId?: string; mode?: "run" | "resume" | "reflect";
  resumeCommand?: { approved: boolean; message?: string };
  conversationId?: string; senderMemberId?: string; parentRunId?: string;
}) {
  const agent = await loadAgentConfig(/* derive agentId from threadId */);
  return {
    schemaVersion: "2",
    agentId: agent.id, threadId,
    runId: overrides?.runId ?? crypto.randomUUID(),
    mode: overrides?.mode ?? "run",
    input,
    model: { provider: agent.modelProvider, model: agent.modelName, ... },
    permissionMode: agent.permissionMode ?? "ask",
    maxSteps: agent.maxSteps ?? undefined,
    conversationId: overrides?.conversationId,
    senderMemberId: overrides?.senderMemberId,
    ...overrides,
  };
}
```

---

## 四、Daemon 侧校验

daemon 收到 `start` 消息后，**单点** `safeParse`：

```ts
const parsed = AgentSpecV2.safeParse(msg.spec);
if (!parsed.success) {
  transport.send({ type: "run_done", runId: msg.runId, status: "error",
    error: parsed.error.message });
  return;
}
const spec = parsed.data;
// 类型安全的判别联合 — switch(spec.mode) 自动缩窄
```

---

## 五、Harness 不依赖此包

`harness-generic` 入参是**解构后的字段**（`AgentFsHandle`、`threadId`、`model` 实例...），不是 `AgentSpec` 整体对象：

```ts
// ✗ 反模式：harness 入参用 AgentSpec
createGenericAgent(spec: AgentSpecV2)

// ✓ 正确：harness 接散字段，runner daemon 负责拆包
createGenericAgent({ workspace, model, threadId, ... })
```

**依赖图**：

```
backend ──┐
          ├──→ agent-spec
daemon ───┘

backend ──→ harness
daemon ───→ harness
harness ✗→ agent-spec       (NOT depends)
```

---

## 六、包结构

```
packages/agent-spec/
├── src/
│   └── index.ts            # zod schema + type 导出（V1 + V2）
├── package.json
└── tsconfig.json
```

零业务逻辑，只有 schema 定义。依赖仅 `zod`。

---

## 七、设计自检

| 问题 | 回答 |
|---|---|
| 为什么不放 `core` 包？ | `core` 是 L1 协议。AgentSpec 是 L5 wire format，不在一个抽象层 |
| 为什么用 `discriminatedUnion`？ | 互斥字段关系编进类型，下游不用 `as` / `!` 断言；`safeParse` 失败时 zod 给出精确错误 |
| 为什么删 `workspace`？ | daemon 启动时已挂载 `AgentFsHandle`，不通过 wire 传文件路径 |
| 为什么删 `storage`？ | checkpointer 是 daemon-local SQLite，backend 不感知其路径 |

---

**AgentSpec 文档结束。** 上游消费：[Backend](./12-backend.md) / [Resident Runner](./16-resident-runner.md)。
