---
title: Agent Backend
description: 五个契约方法、单一 acp kind 与 harness 轴、ACP wire 的事件映射、首轮 flat-text 桥与审批回传端点；改协议边界前读这个
tags: [backend, runs, runtime]
---

# Agent Backend

一句话：本页是 Agent Backend 的权威描述。它是 Product Backend 与执行引擎之间唯一的 Run 级协议边界，产品侧只依赖 `execute / steer / resolveApproval? / stop / dispose` 五个方法；唯一 kind `acp` 经 ACP SDK spawn harness 子进程，harness 轴（claude / omp / pi）由 model ref 的 `harness` 字段决定，`BackendRunOutcome` 是唯一终态权威。

## 范围

覆盖：契约类型（`protocol/` 目录：backend / run / history / event / kinds / model）、ACP 客户端（`acp/` 目录：spawn、事件映射、审批挂起、子进程生命周期）、oma 的本地契约（`core/runtime/contract/`）与其 ACP 服务面、首轮 flat-text 桥与 `cliSessionRef` 续接、审批回传端点。

不覆盖：工作区文件的桥接与工作区布局（见 [Agent 工作区与多后端](../agents/workspace-and-backends.md)）、oma 运行时内部（见 [Oma Runtime](../runtime/oma.md)）、产品侧的 run 状态机与实时更新（见 [Run 输出与实时更新](../runs/output-and-live-updates.md)）、模型与 provider（见 [模型与 Provider](../runtime/models.md)）。

## 实现文件

- `apps/backend/src/features/agent-run/protocol/backend.ts` — `AgentBackend` 接口与 `BackendRegistryEntry` / `BackendRegistry`
- `apps/backend/src/features/agent-run/protocol/run.ts` — `BackendInputMessage`、`BackendRunInput`、`BackendRunOutcome`、`BackendRunSegment`、`PendingAction`
- `apps/backend/src/features/agent-run/protocol/history.ts` — `WorkspaceBinding`、`AgentRunSnapshot`
- `apps/backend/src/features/agent-run/protocol/event.ts` — `CoreBackendEvent`、`BackendExtensionEvent`
- `apps/backend/src/features/agent-run/protocol/kinds.ts` — `BACKEND_KINDS = ["acp"]`
- `apps/backend/src/features/agent-run/acp/acp-backend.ts` — ACP 客户端（spawn、prompt、审批挂起、生命周期）
- `apps/backend/src/features/agent-run/acp/registry.ts` — `ACP_AGENTS` 注册表与 `harnessOf`
- `apps/backend/src/features/agent-run/acp/harness-catalog.ts` — 模型目录探针
- `apps/backend/src/features/agent-run/acp/event-mapping.ts` — ACP session update → backend 事件
- `apps/oh-my-agent/src/core/runtime/contract/` — oma 自声明的运行时契约（ADR 0040 决策八：子定义契约，父适配）
- `apps/oh-my-agent/src/modes/acp/acp-mode.ts` — oma 的 ACP 服务面
- `apps/oh-my-agent/src/protocol/mapping.ts` — child 侧扩展事件映射；`mapping.test.ts` 是两份副本的一致性守卫
- `apps/backend/src/bootstrap/features.ts` — registry 装配、workspace bridge 重写
- `apps/backend/src/features/agent-run/execution-input.ts` — 首轮 flat-text 桥与 Run 快照组装
- `apps/backend/src/features/agent-run/{execution-service,http}.ts` — 审批分发与端点

## 契约方法

| 方法 | 语义 |
|---|---|
| `kind` | 该后端的 kind 字面量（`"acp"`），扩展事件命名空间 `backend.<K>.*` 锁在同一个 K；harness 轴在 model ref 里（`harness` 字段，缺省回退 `modelId`） |
| `execute(input)` | 起一个全新 Run，返回 segment；同 runId 同 payload 幂等（重放已接受的结果），同 runId 不同 payload 冲突 |
| `steer(runId, input)` | 往**当前活着的** Run 注入一条输入；Run 不活时显式失败，绝不悄悄降级成普通输入。ACP v1 对注册表里的 agent 没有 steering，`AcpBackend.steer` 一律显式报错——产品侧入队层把 steer 转成排队的 follow-up |
| `resolveApproval?(runId, callId, decision)` | 可选方法。解决活 Run 里挂起的 HITL 审批；没有审批管道的后端不实现它，产品侧就以它的存在与否决定审批端点是否可用 |
| `stop(runId)` | 请求取消；segment 的 outcome 仍然会解析为 `aborted` |
| `dispose()` | 确定性关停全部 child：拒绝新 execute、取消排队中的 spawn、先 SIGTERM 后 SIGKILL、等每个 child 退出 |

`BackendRunInput.resume`（可选，ADR 0038）：仅在**重派一条停靠中死去的 run** 时出现——该 run 已决定的人机决定清单（callId/kind/response）。oma 子进程据此刻从 session 停靠标记补完中断轮：ask 答案注入为合成 tool_result、allow 审批真执行且决定按 callId 预供（人不重问）、其余诚实落 denied/interrupted。

契约上没有 `abort` 方法，也没有跨 Run 的 session handle。

## 一次 Run 的输入

```ts
interface BackendRunInput {
  input: BackendInputMessage;              // inputId + 规范 Message（+ 可选的 productEntryId）
  run: AgentRunSnapshot;                   // 冻结的 Run 配置
  workspace: WorkspaceBinding;             // { root, access: "read_only" | "read_write" }
  productToolsToken?: string;              // 产品工具 bearer，只经 spawn env 下传
  mcpExpandableVars?: readonly string[];   // 允许在 workspace .mcp.json 里展开的 env 变量名
  consentedMcpTools?: readonly string[];   // 免于权限门禁的 MCP 工具全名
  convTitled?: boolean;                    // 会话已有标题时 child 跳过自动起标题
  workflow?: { script: string; args?: unknown };  // 只有 oma 用：直接跑 workflow 脚本
  metadata?: { conversationId: string; agentId: string; branchId: string };
}
```

**历史不是契约的一部分。** 首轮的上下文由产品侧拍成 flat text 塞进 `input.message`，第二轮起由 harness 自己的 session 承担。

`AgentRunSnapshot` 冻结在 Run 创建时：

| 字段 | 说明 |
|---|---|
| `runId` | 唯一的执行身份，也是 oma child 的 SessionStore id |
| `model` | `{ modelId, reasoningEffort?, harness?, harnessModel? }`。父侧保留 harness 两字段做路由；子进程只消费 `modelId` / `reasoningEffort` |
| `systemPrompt` | Run 级系统提示；产品侧在这里追加 Product Context 段 |
| `skillRoots` | 绝对目录数组，Run 创建时冻结；插件的技能索引从这里扫描 |
| `cliSessionRef` | 该分支的原生 session 引用，缺省 = 全新 session |
| `permissionMode` | `ask` / `auto` / `deny` / `yolo` |
| `workflowBudgetTokens` | 可选的 workflow token 预算 |
| `configRevision` | 配置版本号 |

产品工具的定义不走快照，走工作区文件 `.oma/product-tools.json`。

## 终态

```ts
type BackendRunOutcome =
  | { status: "completed"; messages?; usage?; title?; summary?; cliSessionRef?; workflow? }
  | { status: "failed" | "aborted" | "timeout"; error?; usage?; cliSessionRef?; messages? };
```

四个终态：`completed` / `failed` / `aborted` / `timeout`。`completed` 带完整的规范消息序列（assistant tool_use、tool result、assistant 文本按顺序分开），最后一条带文本的 assistant 消息就是最终答复。`failed` / `aborted` / `timeout` 也带已经落库的消息，供下一轮续接。没有第五个终态，事件流永远不决定终态。

## 事件

`CoreBackendEvent` 是稳定的核心集合：

| 事件 | 载荷 |
|---|---|
| `text_delta` / `thinking_delta` | `text` |
| `native_tool_started` / `native_tool_completed` | `toolName`、`callId`，完成时可选 `result` |
| `product_tool_started` / `product_tool_completed` | 同上，区分产品工具与后端原生工具 |
| `pending_action` | `actionId` |
| `status` | `status`、可选 `error` |
| `delegation_batch_started` / `delegation_agent_started` / `delegation_agent_completed` / `delegation_batch_completed` | 批次与子代理身份、计数、用量 |

各 harness 私有的诊断事件走 `backend.<K>.<event>` 扩展命名空间（如 `backend.oma.todo_update`），产品状态机不读它。

## Registry 与分发

`BackendRegistry` 是一张 `Partial<Record<BackendKind, BackendRegistryEntry>>` 表，每个 entry 是 `{ backend, catalog }`：backend 干活，catalog 报模型。当前只有一个 `acp` entry。执行侧按 `modelRef` 查表分发，`harnessOf(ref)` 取 harness（显式字段优先，缺省回退 `modelId` 的历史打包形式）；遇到未注册的 harness 直接报错，不做静默回落——静默回落会 spawn 出一个 Run 没点名的 harness，错误被掩盖成"看起来成功"。

catalog 来自 `harness-catalog.ts` 的探针：对每个 harness 真跑一次其 CLI 的模型列举并缓存。

## ACP wire

每个 Run 一个一次性子进程，由 ACP SDK 的 stdio transport 承载 JSON-RPC。一次 execute 的生命周期：

```text
spawn harness CLI → initialize → session/new → set_config(model)
→ prompt(input) → sessionUpdate 通知流 → session/end
```

- `event-mapping.ts` 把 ACP session update 映射成 backend 事件（agent_message_chunk → `text_delta`、tool_call → `native_tool_*`、extension update → `backend.<K>.*`）。
- child 侧的对偶映射在 `apps/oh-my-agent/src/protocol/mapping.ts`：oma 把自己的 `backend.*` 事件发成 ACP session update。`mapping.test.ts` 钉住两份定义不走散。
- ACP permission request 在 `AcpBackend` 里挂成 `HeldPermission`：Web 审批卡放行 → `resolveApproval` 把决定回给 harness；超时按 deny 结算。
- `drive()` 的收尾会 kill 活得比 Run 久的 harness 子进程（否则每次泄漏一个活进程）；`hangOnExit` 行为有测试钉住。
- 命令（prompt/permission resolve）有超时；协议违例 = 该 Run settle 为 `failed` 并杀掉 child。
- 产品工具 token 只经 spawn env 下传，wire 上的输入里被剥掉。

## harness 注册表

harness 由 `ACP_AGENTS` 声明：CLI 可执行、spawn 参数、catalog 探针。本仓库当前注册 claude / omp / pi 三个 harness；每个 harness 的 CLI 参数差异封装在各自的 ACP 桥里，Product Backend 看不到 argv——它只看到 `execute(input)`。

session 续接经 ACP 的 session 机制：`cliSessionRef` 由各 harness 桥翻译成自己的续接方式，产品只存和回传这个不透明字符串。

## 首轮桥与 session 续接

- 分支还没有 `cliSessionRef` 且投影非空时，产品侧把投影拍成 `## Conversation so far` 文本，前置到本次 `input.message` 上；有 session 引用之后不再拍。
- 同一步里把 Product Context 段（runId / conversationId / agentId / branchId 加当前任务列表）拼进 `systemPrompt`，并把 `skillRoots`、`permissionMode` 冻进快照。
- outcome 回传 `cliSessionRef`，产品把它存在 context branch 上。oma child 把这一轮的 user / assistant / tool 消息追加进自己的 session 文件，下一轮 `cliSessionRef` 命中时把 transcript 当 seed 载入。

## 审批回传

```text
harness 发 ACP permission request（callId / toolName / reason / input）
→ AcpBackend 挂成 HeldPermission → pending_action → SSE → Web 卡片
→ POST /api/agent-runs/:runId/approval  { callId, decision: "allow" | "deny" }
→ 执行服务查该 Run 的 kind → 调 entry.backend.resolveApproval
```

端点三种失败：run 不存在 404，run 已经终态 409，body 不合法 400。执行服务在调 backend 之前先检查该 entry 有没有 `resolveApproval`，没有就报错——这是"这个后端有没有审批管道"的唯一判据。审批链的其余部分（permissionMode 的分支、分类器、超时）见 [Oma 插件与 HITL](../plugins/oma-plugins.md)。

## 不变量

1. Product Backend 只依赖这五个契约方法；执行细节全部留在 ACP 客户端内。
2. `runId` 是唯一执行身份，每个 Run 一个一次性子进程，Run 之间不共享进程状态。
3. Terminal `BackendRunOutcome` 是 Agent Run 终态的唯一来源，事件流只用于观测。
4. 同一个 Run 的 segment 只解析一次终态；同 runId 不同 payload 是冲突，不是新 Run。
5. 产品工具 token 只经 spawn env 下传，绝不出现在 wire 的输入里。
6. session 引用是不透明字符串：产品只存和回传，不读也不写 child 的 session 文件。
7. harness 是 model ref 的一部分：跨 harness 没有 session 可移植性，缺省回退（换 harness 跑）是错误不是降级。

## 已知缺口

- steer 缺失是 ACP v1 的协议限制（`_meta.steering` 未被注册表 agent 声明），不是实现偷懒；协议升级后 `AcpBackend.steer` 的显式报错点是唯一要改的地方。
- catalog 探针要求 harness CLI 真实可执行；CLI 缺席时该 harness 的模型目录为空，run 会在 preflight 报 unknown model。
- 两份扩展事件映射（child 的 `protocol/mapping.ts` 与 backend 的 `event-mapping.ts`）靠 `mapping.test.ts` 守一致性；新增 `backend.<K>.*` 事件时两边要同步加。

## 相关页

- [Agent 工作区与多后端](../agents/workspace-and-backends.md) — 工作区文件与 bridge
- [Oma Runtime](../runtime/oma.md) — oma child 内部
- [模型与 Provider](../runtime/models.md) — catalog 与凭证
- [Run 输出与实时更新](../runs/output-and-live-updates.md) — 产品侧怎么消费事件
- [跨进程契约规则](../e2e-contract-rules.md) — 改 wire 前必读
