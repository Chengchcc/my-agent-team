---
title: Agent Backend
description: 五个契约方法、四个 adapter 的 spawn 参数差异、oma 的 JSONL wire、首轮 flat-text 桥与审批回传端点；改协议边界前读这个
tags: [backend, runs, runtime]
---

# Agent Backend

一句话：本页是 Agent Backend 的权威描述。它是 Product Backend 与执行引擎之间唯一的 Run 级协议边界，产品侧只依赖 `execute / steer / resolveApproval? / stop / dispose` 五个方法；四个 kind（`oma` / `claude_code` / `pi` / `omp`）各由一个 adapter 包实现，每个 Run 起一个一次性子进程，`BackendRunOutcome` 是唯一终态权威。

## 范围

覆盖：契约类型（backend / run / history / event / kinds / model / env）、BackendRegistry 的装配与分发、oma 的 JSONL wire、四个 adapter 的 spawn 与参数差异、首轮 flat-text 桥与 `cliSessionRef` 续接、审批回传端点。

不覆盖：工作区文件的桥接与工作区布局（见 [Agent 工作区与多后端](../agents/workspace-and-backends.md)）、oma 运行时内部（见 [Oma Runtime](../runtime/oma.md)）、产品侧的 run 状态机与实时更新（见 [Run 输出与实时更新](../runs/output-and-live-updates.md)）、模型与 provider（见 [模型与 Provider](../runtime/models.md)）。

## 实现文件

- `packages/agent-contract/src/backend.ts` — `AgentBackend<K>` 接口与 `BackendRegistryEntry` / `BackendRegistry`
- `packages/agent-contract/src/run.ts` — `BackendInputMessage`、`BackendRunInput`、`BackendRunOutcome`、`BackendRunSegment`、`PendingAction`
- `packages/agent-contract/src/history.ts` — `WorkspaceBinding`、`AgentRunSnapshot`
- `packages/agent-contract/src/event.ts` — `CoreBackendEvent`、`BackendExtensionEvent`
- `packages/agent-contract/src/kinds.ts` — `BACKEND_KINDS`
- `packages/adapter-oma-agent/src/{backend,protocol,event-mapper,process,model-catalog}.ts` — oma adapter
- `packages/adapter-claude-agent/src/{backend,event-mapper,model-catalog}.ts` — claude adapter
- `packages/adapter-pi-agent/src/{backend,event-mapper,model-catalog}.ts` — pi adapter
- `packages/adapter-omp-agent/src/{backend,event-mapper,model-catalog}.ts` — omp adapter
- `apps/oh-my-agent/src/protocol/transport.ts` — child 侧的 wire 定义；`protocol/drift.test.ts` 是两份副本的一致性守卫
- `apps/backend/src/bootstrap/features.ts` — registry 装四个 entry、workspace bridge 重写
- `apps/backend/src/features/agent-run/execution-input.ts` — 首轮 flat-text 桥与 Run 快照组装
- `apps/backend/src/features/agent-run/{execution-service,http}.ts` — 审批分发与端点

## 契约方法

| 方法 | 语义 |
|---|---|
| `kind` | 该后端的 kind 字面量，扩展事件命名空间 `backend.<K>.*` 与输入里的 model ref 都锁在同一个 K |
| `execute(input)` | 起一个全新 Run，返回 segment；同 runId 同 payload 幂等（重放已接受的结果），同 runId 不同 payload 冲突 |
| `steer(runId, input)` | 往**当前活着的** Run 注入一条输入；Run 不活时显式失败，绝不悄悄降级成普通输入 |
| `resolveApproval?(runId, callId, decision)` | 可选方法。解决活 Run 里挂起的 HITL 审批；没有审批管道的后端不实现它，产品侧就以它的存在与否决定审批端点是否可用 |
| `stop(runId)` | 请求取消；segment 的 outcome 仍然会解析为 `aborted` |
| `dispose()` | 确定性关停全部 child：拒绝新 execute、取消排队中的 spawn、先 SIGTERM 后 SIGKILL、等每个 child 退出 |

契约上没有 `abort` 方法，也没有跨 Run 的 session handle（oma 的 wire 里那条 `abort` 命令是 adapter 实现 `stop` 的手段，不是契约方法）。

## 一次 Run 的输入

```ts
interface BackendRunInput<K extends string = string> {
  input: BackendInputMessage;              // inputId + 规范 Message（+ 可选的 productEntryId）
  run: AgentRunSnapshot<K>;                // 冻结的 Run 配置
  workspace: WorkspaceBinding;             // { root, access: "read_only" | "read_write" }
  productToolsToken?: string;              // 产品工具 bearer，只经 spawn env 下传
  mcpExpandableVars?: readonly string[];   // 允许在 workspace .mcp.json 里展开的 env 变量名
  consentedMcpTools?: readonly string[];   // 免于权限门禁的 MCP 工具全名
  convTitled?: boolean;                    // 会话已有标题时 child 跳过自动起标题
  workflow?: { script: string; args?: unknown };  // 只有 oma 用：直接跑 workflow 脚本
  metadata?: { conversationId: string; agentId: string; branchId: string };
}
```

**历史不是契约的一部分。** 首轮的上下文由产品侧拍成 flat text 塞进 `input.message`，第二轮起由 CLI 自己的 session 承担。

`AgentRunSnapshot` 冻结在 Run 创建时：

| 字段 | 说明 |
|---|---|
| `runId` | 唯一的执行身份，也是 oma child 的 SessionStore id |
| `model` | `{ backendKind, modelId }`，kind 锁死该输入只能走对应 adapter |
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

各后端私有的诊断事件走 `backend.<K>.<event>` 扩展命名空间，产品状态机不读它。

## Registry 与分发

`BackendRegistry` 是一张 `Partial<Record<BackendKind, BackendRegistryEntry>>` 表，每个 entry 是 `{ backend, catalog }`：backend 干活，catalog 报模型。它在 bootstrap 一次性装齐四个 kind，执行侧按 `modelRef.backendKind` 查表分发；遇到未注册的 kind 直接报错，不做静默回落。

catalog 实现各不相同：oma 真跑一次 `oma --list-models` 并缓存结果，另外三个是各包内的静态表。

## oma 的 JSONL wire

oma kind 走 stdin/stdout 严格 JSONL，stdout 只承载协议：

```text
commands (stdin)    execute | steer | abort | resolve_approval   （按 command id 匹配）
outputs  (stdout)   response | event | outcome
stderr              只有日志（adapter 保留 64KiB 尾部并做脱敏）
```

adapter 侧的行为，逐条都能在 `packages/adapter-oma-agent/src/backend.ts` 指出来：

- FIFO spawn slot：`maxConcurrent` 限定同时活着的 child 数，多出来的 execute 排队等 slot，排队期间输入仍未投递；排队中的 Run 被 `stop` 时直接取消等待，绝不 spawn。`0` 表示不限并发。
- `execute` 只在 child **接受**（runtime 装配好、steer/abort 已经可路由）之后才返回 segment；拒绝时 reap child，输入保持未接受。
- steer / abort / resolve_approval 都是写一条命令再等回包，命令 id 匹配，30 秒超时。
- 协议违例（帧不合 schema）＝ 该 Run settle 为 `failed` 并杀掉 child，错误信息带 stderr 尾部。
- 收到 outcome 先 reap 再 settle；stdout 关闭却始终没有 outcome，也 settle 为 `failed`。
- 产品工具 token 只经 spawn env 下传，wire 上的输入里被剥掉。

**wire 是两份手写副本**：child 侧 `apps/oh-my-agent/src/protocol/transport.ts`，adapter 侧 `packages/adapter-oma-agent/src/protocol.ts`。`apps/oh-my-agent/src/protocol/drift.test.ts` 读 adapter 源码文本比对，防两份定义走散。

## 四个 kind 的 spawn 形状

每个 Run 一个一次性子进程。oma 走 `--mode rpc`（开发环境下用同一个 Bun 可执行文件直接跑 `apps/oh-my-agent/src/cli.ts`）；三个 CLI 后端用 argv + stdin：

| kind | 关键参数 | session 续接 | steer |
|---|---|---|---|
| `oma` | `--mode rpc` | `cliSessionRef` 指向自己的 session 文件 | 支持 |
| `claude_code` | `--output-format stream-json --input-format stream-json --verbose -p`、`--model <裸名>`、`--effort`、`--permission-mode`（auto→acceptEdits、deny→plan、ask→default）、`--mcp-config`、`--append-system-prompt` | `--resume <sessionId>` | 显式拒绝 |
| `pi` | `-p --mode json`、`--provider` / `--model`（按 `/` 拆开）、`--tools read,bash,edit,write,grep,find,ls,mcp,mcpScript`、`--extension <pi-mcp-adapter 路径>`、`--append-system-prompt` | `--session <ref>` | 显式拒绝 |
| `omp` | `-p --mode json`、`--model`、`--tools read,bash,edit,write,grep,glob`、`--thinking <off\|low\|high\|max>`、`--append-system-prompt` | `-r <ref>` | 显式拒绝 |

三个 CLI adapter 都不实现 `resolveApproval`，`steer` 一律抛错（提示把输入排成 follow-up），`stop` 是 SIGTERM 加一个有界宽限后的 SIGKILL。

## 首轮桥与 session 续接

- 分支还没有 `cliSessionRef` 且投影非空时，产品侧把投影拍成 `## Conversation so far` 文本，前置到本次 `input.message` 上；有 session 引用之后不再拍。
- 同一步里把 Product Context 段（runId / conversationId / agentId / branchId 加当前任务列表）拼进 `systemPrompt`，并把 `skillRoots`、`permissionMode` 冻进快照。
- outcome 回传 `cliSessionRef`，产品把它存在 context branch 上。oma child 把这一轮的 user / assistant / tool 消息追加进自己的 session 文件，下一轮 `cliSessionRef` 命中时把 transcript 当 seed 载入。

## 审批回传

```text
child 发 approval_request 事件（callId / toolName / reason / input / sandboxed?）
→ adapter 透传成 backend.oma.* 事件 → SSE → Web 卡片
→ POST /api/agent-runs/:runId/approval  { callId, decision: "allow" | "deny" }
→ 执行服务查该 Run 的 kind → 调 entry.backend.resolveApproval
```

端点三种失败：run 不存在 404，run 已经终态 409，body 不合法 400。执行服务在调 adapter 之前先检查该 kind 的 adapter 有没有 `resolveApproval`，没有就报错——这是"这个后端有没有审批管道"的唯一判据。审批链的其余部分（permissionMode 的分支、分类器、超时）见 [Oma 插件与 HITL](../plugins/oma-plugins.md)。

## 不变量

1. Product Backend 只依赖这五个契约方法；执行细节全部留在 adapter 内。
2. `runId` 是唯一执行身份，每个 Run 一个一次性子进程，Run 之间不共享进程状态。
3. Terminal `BackendRunOutcome` 是 Agent Run 终态的唯一来源，事件流只用于观测。
4. 同一个 Run 的 segment 只解析一次终态；同 runId 不同 payload 是冲突，不是新 Run。
5. 产品工具 token 只经 spawn env 下传，绝不出现在 wire 的输入里。
6. session 引用是不透明字符串：产品只存和回传，不读也不写 child 的 session 文件。

## 已知缺口

- wire 的两份副本已经实际漂移：child 侧的 mapping 透传 `delegation_batch_started.source`，adapter 副本与契约类型里都没有这个字段。`drift.test.ts` 只比对命令与输出的 schema 文本，覆盖不到 event-mapper。
- `claude_code` / `pi` / `omp` 的 model catalog 是各包内的静态表，不会随 CLI 版本变化；只有 `oma` 真跑 CLI 取目录。
- claude CLI 在 root 下拒绝 `--permission-mode bypassPermissions`，当前替代是往工作区写 `.claude/settings.json` 预放行产品工具（见 [Agent 工作区与多后端](../agents/workspace-and-backends.md)）。

## 相关页

- [Agent 工作区与多后端](../agents/workspace-and-backends.md) — 工作区文件与 bridge
- [Oma Runtime](../runtime/oma.md) — oma child 内部
- [模型与 Provider](../runtime/models.md) — catalog 与凭证
- [Run 输出与实时更新](../runs/output-and-live-updates.md) — 产品侧怎么消费事件
- [跨进程契约规则](../e2e-contract-rules.md) — 改 wire 前必读
