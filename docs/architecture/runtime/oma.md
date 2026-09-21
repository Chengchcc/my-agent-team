---
id: runtime.oma
title: Oma Runtime
status: current
owners: architecture
summary: "oma 是 CLI 执行引擎（四种模式：print/json/rpc 一次性 + TUI 交互终端），由 Adapter 按 Run spawn 其 rpc 模式。子进程内 createOmaRuntime() 构造 per-Run Runtime：model/tool loop、in-memory SessionStore、compaction、todo、skill 渐进加载、插件加载与信任、HITL 审批。Run 级 systemPrompt/skillRoots 冻结，Meta+Prompt+full projection 三条 user 消息 seed。"
depends_on:
  - execution.agent-backend
used_by:
  - agents.context
  - architecture.workflow
---

# Oma Runtime

`apps/oh-my-agent` 是自研执行引擎：一个 CLI，四种模式。Product Backend 的 Adapter 按**每个 Agent Run** spawn 其 **rpc 模式**（非交互，stdin/stdout JSONL）；`print`/`json` 同样是一次性模式；**TUI 是面向人的交互式终端**（独立启动，不是 backend 的执行路径）。

```text
Product Backend → Adapter (packages/adapter-oma-agent)
  → spawn oma --mode rpc
    → createOmaRuntime(): per-Run Runtime
      → model/tool loop（core/runtime/agent-loop-runner.ts；agent-loop.ts 是 session 工厂）
      → BackendRunOutcome → stdout → exit
```

**不是 daemon**：无常驻进程、无 worker pool。一个 Run = 一个子进程 = 一个 Runtime = 一个 outcome。

## CLI 模式

| 模式 | 用途 |
|---|---|
| `print` | 一次 Run；stdout 只有 final assistant text |
| `json` | 一次 Run；stdout 全部事件 JSONL + 恰好一个 terminal outcome 行 |
| `rpc` | 每 Run 一次 execute + 可选 steer/abort/resolve_approval；stdin 命令、stdout event/outcome/response |
| TUI | 交互式终端（ESC-ESC 面板、branch-tree、模型选择持久化到 `.oma/settings.json`） |

`rpc` 是 Adapter 使用的模式：严格 LF JSONL 帧，stdout 只承载协议。

## per-Run 状态：in-memory SessionStore

Runtime 状态是 **per-Run、in-memory** 的执行缓存（`core/store/`），不是产品历史：

```text
Agent Context  = canonical product context（跨 Run 持久、可 fork/rollback）
SessionStore   = 单次 Run 执行缓存（messages + compaction 摘要）
                 子进程退出即销毁；下个 Run 重新 seed full projection
```

`sessionId = runId`；seed 时原子 appendBatch：

```text
full Product history（projected entries，带 productEntryId）
+ Meta User Message（source=meta）
+ Actual Prompt（source=prompt）
→ Agent Loop 在 session 上跑 → outcome 后 close() 销毁
```

- 同 Run 内 retry 复用同一 session（input batch 不重复追加）；steer 追加 `source=steer` 消息；follow-up 是**新 Run**（新子进程 + 新 session + 新 full seed）
- `productEntryId` 保证同一 canonical Message 在 Run 内幂等；compaction 写 `CompactionEntry`（summary + 覆盖范围），原始 entries 不删

## 模型每次收到什么

```text
System Prompt   不写 SessionStore（来自 agent_run.system_prompt 冻结快照）
Meta User Message  写 SessionStore，source=meta（Runtime Context: 日期/workspace/
                  Memory 摘要索引/skill index/branch 上下文/todo reminder）
Actual Prompt   写 SessionStore，source=prompt
Full history    写 SessionStore，source=product_history
```

- systemPrompt/skillRoots 是 Run 创建时冻结的快照；SOUL/规则变化从**下一个 Run** 生效
- 每 Run 恰好一条 Meta；retry/steer 不重新渲染 Meta；follow-up 重新读取最新快照
- skills 渐进加载：Meta 只注入 `skillRoots` 扫描出的名称/描述/加载规则，`skill_load` 按需读 `SKILL.md` 正文

## 模型系统（packages/ai）

- Provider 注册制 + Model 元数据（cost/contextWindow/maxTokens）+ `createModelRuntime()` 统一解析与 stream
- Product Backend 只保存 `BackendModelRef { backendKind, modelId }`；凭证经 env 注入子进程，不进 SessionStore/事件/日志
- Agent Loop 只自动 retry transient error（network/rate_limit/overload/5xx）；context overflow 触发 compaction recovery；auth/4xx 不盲目重试
- 模型切换：Context Branch 的 `model_change` entry 决定下一个 Run 的 effective model；当前 Run 用冻结快照值

## Runtime 拥有什么

- model/tool loop（`core/runtime/agent-loop-runner.ts` 是唯一的 loop 实体：`runModelTurnLoop` + `runLoop`；`core/runtime/agent-loop.ts` 只是 `createOmaSession()` 的组装层）
- native tools（read/read_image/ls/tree/write/edit/bash/grep/glob/web/eval——eval 走进程沙箱；ls 与 tree 是只读目录视图，read_only 也有）+ MCP 工具挂载（mcp-mount 多源合并）
- retry、compaction、workspace todo（`.oma/todo.json`，跨 Run 持久）、tool-result pruning（读侧截断旧工具输出，由 `.oma/settings.json` 的 `prune` 显式开启）
- 插件系统：代码加载（native import）、信任矩阵（sha256 + trusted-plugins.json）、marketplace 多源 manifest（见 [Oma 插件与 HITL](../plugins/oma-plugins.md)）
- HITL 审批管道：permissionMode 门控工具——ask=`approval_request` → `resolve_approval`（超时 fail-closed deny）、deny=直接 block、auto=分类器审查（bash/eval/mcp__*/插件工具逐调用过分类器，write/edit 免审，故障 fail-closed；见 [Oma 插件与 HITL](../plugins/oma-plugins.md)）
- stream rules（TTSR）：`.oma/rules/*.md` 在 assistant 文本流上匹配，命中即中止本轮、注入 `<system-reminder>` 后同轮重试
- 工具失败 system reminder：失败 tool_result 前置 `<system-reminder>`（修因重试，勿装作成功）
- TUI 的 turn driver（goal / loop / plan）：让会话在用户不再输入时继续推进的三个模式，互斥认领回合（见下节）

## TUI 的 turn driver（goal / loop / plan）

TUI 有三个**回合驱动**：它们都能在用户不再输入的情况下继续推进会话，因此互斥——任一驱动认领本回合后，其余两个立即停止。

| 驱动 | 入口 | 形态 |
|---|---|---|
| loop | `/loop [次数\|时长] [--while\|--until <cmd>] [prompt]` | 每轮结束后重投同一个 prompt |
| goal | `/goal`、`/guided-goal` | 一个跨轮次的目标，由模型用工具声明完成 |
| plan | `/plan`、`/plan-review` | 只读调查 → 起草计划 → 人工复审后实施 |

- **迭代间动作**由 `.oma/settings.json` 的 `loopAction` 决定：`prompt`（重投）/ `compact`（先摘要）/ `reset`（先开新会话）/ `ralph`（构建循环）。
- **条件门**：`--until`/`--while` 跑一条 shell 命令，**退出码是唯一权威**（stdout 忽略）；退出码 >1 表示条件本身坏了，按错误中止而不是当成"条件为假"。求值在预算消耗之前发生；求值期间驱动若被改变（Esc、`/loop` 重开），该裁决作废。
- **构建循环**（`loopAction: "ralph"`）：工作队列 `.oma/plan.md`（`- [ ]` 待办 / `- [x]` 完成）。队列是**项目级**的，因为每轮都是新会话——若按会话存放，每轮都会拿到一个空文件而丢掉进度。每轮做队列里最重要的一项、跑验证、标记完成、提交；默认停止条件就是队列本身（还有未勾选项就继续），`--until` 可把权威换成验证器。
- **plan 的草稿**写在 `.oma/plans/<sessionId>.md`（会话级，因为复审面属于"这个会话的计划"）。只读由 file tool 守卫强制（write/edit 只放行该路径）；**bash 仍只靠提示词约束**，这是诚实记录的缺口。
- 驱动协议提示词走**隐藏输入通道**（`[goal-mode]` / `[ralph-loop]`）：只送达模型，不回显、不落会话文件（落了的话 `/resume` 会把它们回放成幽灵用户气泡）。
- 会话切换（`/resume`、`/new`）不会让任何驱动自动继续：loop 关闭，plan 与 goal 恢复为 paused。loop 自己发起的 `/new`（`--keep-loop`）是唯一例外，否则每轮都要重启会话的循环会在第一轮就结束自己。

## 事件与终态

子进程把 Runtime 事件包装为 `RunEventEnvelope` 发 stdout；Adapter 用自己的映射（`packages/adapter-oma-agent/src/event-mapper.ts`，与 child 的 `src/protocol/mapping.ts` 是**两份独立实现**，ADR 0024）转成 `BackendEvent` / `BackendRunOutcome`（completed/failed/aborted/timeout）。outcome 是唯一终态权威，事件流永不决定终态。

## 不变量

1. Oma 不是 daemon；每次被 Adapter 按 Run spawn
2. 一个 Run 一个子进程一个 Runtime；child 在 outcome 后自行退出
3. Runtime 不访问 Product DB；输入只有 full projection + snapshot
4. runId 是唯一执行身份；SessionStore 不跨 Run
5. stdout 只承载协议（rpc），stderr 只做日志
6. 每 Run 恰好一条 Meta User Message；retry/steer 不重新渲染
7. Product Tool 的权限与事实归 Product Backend，child 只经 MCP 调用
8. 插件 project-scope 代码永不进 RPC 模式加载

## 关联页面

- [Oma Tools](./oma-tools.md)
- [Oma 插件与 HITL](../plugins/oma-plugins.md)
- [Agent Backend](../execution/agent-backend.md)
- [Agent Context](../agents/context.md)
- [Workflow](../workflow.md)
