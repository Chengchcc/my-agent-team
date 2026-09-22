---
title: 后端实测记录 Gate 0
description: 2026-08-12 至 08-13 的一次点时间实测快照（claude/pi/omp 的调用形状与事件映射），不是现状契约，只在解释 adapter 为何长成这样时参考
tags: [backend, runs, models]
---

# Backend Kinds：Gate 0 实测记录

一句话：本页是 **2026-08-12 至 08-13** 一次本机实测留下的记录，内容是 claude / pi / omp 三个 CLI 后端的调用形状、wire 事件型录与到 `CoreBackendEvent` 的映射依据。它是一份点时间快照，**不是现状契约**：现行实现以各 adapter 的 `backend.ts`、`event-mapper.ts` 与 `apps/oh-my-agent/src/protocol/drift.test.ts` 为准，本页只在解释那些代码为什么长成这样时有参考价值。

## 范围

覆盖：三个 CLI 的实测调用形状、事件型录、usage 提取点、终态信号、以及"三家都没有协议内 abort"这条结论。

不覆盖：现行 adapter 的实际参数与行为（见 [Agent Backend](./agent-backend.md)）、oma 自己的 wire（见 [Agent Backend](./agent-backend.md)）、审批与权限管线（见 [Oma 插件与 HITL](../plugins/oma-plugins.md)）。

## 实现文件

本记录被三处源码注释点名引用，改文件名要连带改这三处：

- `packages/adapter-claude-agent/src/backend.ts` — 头注释指向本文件作为 stream-json 的 wire 记录
- `packages/adapter-omp-agent/src/backend.ts` — 同上
- `packages/adapter-pi-agent/src/backend.ts` — 头注释标注 pi 未真机验证，指向本记录

## 当时的实测环境

| 项 | 结果 |
|---|---|
| `claude` | `/usr/bin/claude`（npm 全局 `@anthropic-ai/claude-code`），版本从 2.1.165 升到 2.1.228，API 面零变化：stream-json 全套 flag、wire 事件型录与 2.1.165 同构 |
| `pi` | `@earendil-works/pi-oma@0.84.1`（全局 bun，bin 为 `pi`）；2026-08-13 抓过真机 wire：事件型录与源码一致，另有 `agent_settled`（忽略即可），`--session <path>` 写与续都实锤 |
| `omp` | `@oh-my-pi/pi-oma@17.2.15`，bin 为 `omp`。与 `pi` 是两个不同产品 |
| 模型通路 | omp 走 `deepseek/deepseek-v4-flash`（api 为 openai-completions）实测通；claude 本机自带凭据实测通 |

版本号是当日实测值，本次未复验。pi 那两处口径当时就不一致：环境段记已抓真机 wire，而 pi 段落标题与 adapter 头注释写的仍是"未真机"。

## claude：stream-json

调用形状（当日实证可用）：

```text
claude --output-format stream-json --input-format stream-json --verbose -p
stdin：一行 {"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
```

`--input-format stream-json` 官方注明只能与 `--print` 一起用。

| 事件 | 载荷要点 | 映射 |
|---|---|---|
| `system` / `hook_started`、`hook_response` | — | 忽略 |
| `system` / `init` | `session_id`、`tools[]`、`cwd` | 记 session_id |
| `system` / `thinking_tokens` | 高频（当日 197 条） | 忽略，未知 subtype 一律忽略以向前兼容 |
| `assistant` | `message.content[]` 里的 `thinking` / `text` / `tool_use`，`message.usage` | text → `text_delta`，thinking → `thinking_delta`，tool_use → `native_tool_started` |
| `user` | `message.content[]` 里的 `tool_result` | → `native_tool_completed` |
| `result` | `subtype: "success"`、`result`、`is_error`、`session_id`、`usage`、`modelUsage` | 终态与 usage 权威点 |
| `error` | `error_text` | 终态 `failed` |

usage 权威点是 `result.modelUsage`（按 model 分键）。终态信号是 `result`（用 `is_error` 区分）或 `error` 或进程退出。abort 只能直接杀进程。

当日实测的本地限制：root 下 `--permission-mode bypassPermissions` 被拒（`--dangerously-skip-permissions cannot be used with root/sudo`）；默认权限下工具可执行，但 shell 输出重定向被沙箱挡（只允许写工作目录）。这两条后来都写进了 adapter 的注释与 workspace bridge 的替代方案。

## pi：json 模式

调用形状（当时据源码与 solo parser 对齐）：

```text
pi -p --mode json --session <path> [--provider X] [--model Y] --tools read,bash,edit,write,grep,find,ls [--append-system-prompt S] <prompt>
```

| 事件 | 载荷 | 映射 |
|---|---|---|
| `agent_start` / `agent_end{messages}` | — | 忽略；尾部可作全量消息源 |
| `turn_start` / `turn_end{message,toolResults}` | message 含 `model`、`usage{input,output,cacheRead,cacheWrite,totalTokens}` | usage 提取点 |
| `message_start` / `message_end{message}` | 完整消息对象 | `message_end` 的 assistant 消息是终态文本兜底 |
| `message_update{assistantMessageEvent}` | delta 流 | → `text_delta` / `thinking_delta` |
| `tool_execution_start{toolCallId,toolName,args}` | — | → `native_tool_started` |
| `tool_execution_update` | partialResult | 忽略 |
| `tool_execution_end{toolCallId,toolName,result,isError}` | — | → `native_tool_completed` |
| `auto_retry_end{success,finalError}` | — | 失败信息兜底 |

session 用 `--session <path|id>` 写与续；当时推断 fork 等于复制会话文件再加 `--session <副本路径>`，未真机验证。usage 提取点是 `turn_end.message.usage`。终态是进程退出加退出码。

## omp：json 模式

调用形状（实测）：

```text
omp -p --mode json [--session <path>] [--model M] [--provider P] [--tools …] <prompt>
```

`--session` 不在 help 里但被接受（写会话文件）；续接用 `-r/--resume <path|id|prefix>`。`--provider` 标着 legacy 但仍可用。

| 事件 | 载荷 | 映射 |
|---|---|---|
| `session{version,id,timestamp,cwd}` | 首行 | 忽略 |
| `agent_start` / `agent_end{messages,isTerminal}` | — | 忽略 |
| `turn_start` / `turn_end{message,toolResults}` | message 含 `usage{…,cost}` 与 `stopReason` | 终态兜底与 usage 提取点之一 |
| `message_start` / `message_end{message}` | 完整消息对象，assistant 消息带 usage | **usage 权威点** |
| `message_update{assistantMessageEvent}` | delta 流 | → `text_delta` / `thinking_delta` |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | — | → `native_tool_started` / `native_tool_completed` |
| `error` | 未触发过 | `failed` 兜底 |

session 续接当日实测通过：复制会话文件后 `omp -r <副本>` 能续上下文，用量里的 cacheRead 非零证明历史被载入。终态是进程退出加 `agent_end`。

MCP 通路当日确认：omp 读工作区级 `.mcp.json`（`{$schema, mcpServers}`，与 claude `--mcp-config` 同格式）；pi 走官方扩展 `pi-mcp-adapter`，机制是一个 proxy 工具按需拉起 server，同样读 `.mcp.json`。这一条后来落成了 workspace bridge 写单一 `.mcp.json` 的设计。

## 事件映射总表

| CoreBackendEvent | claude | pi | omp |
|---|---|---|---|
| `text_delta` | assistant.content[text] | message_update.text_delta | message_update.text_delta |
| `thinking_delta` | assistant.content[thinking] | message_update.thinking_delta | message_update.thinking_delta |
| `native_tool_started` | assistant.content[tool_use] | tool_execution_start | tool_execution_start |
| `native_tool_completed` | user.content[tool_result] | tool_execution_end | tool_execution_end |
| `status` | system（init 起） | — | — |
| usage 提取 | result.modelUsage 与 assistant.usage | turn_end.message.usage | message_end.message.usage |
| 终态信号 | result / error / 进程退出 | 进程退出加退出码 | agent_end / 进程退出 |
| abort 语义 | kill 进程 | kill 进程 | kill 进程 |

## 不变量

1. 三个 CLI 都没有协议内的 abort，取消一律是杀进程；oma 有协议内 abort，这是两者唯一在取消语义上的结构差异。
2. usage 必须从表格里那一列指定的位置取，换位置会静默算错账。
3. 未知事件类型一律忽略，不做报错——三个 CLI 都会随版本新增事件（`agent_settled`、`thinking_tokens` 都是这么冒出来的）。

## 相关页

- [Agent Backend](./agent-backend.md) — 现行契约与四个 adapter 的实际形状
- [Agent 工作区与多后端](../agents/workspace-and-backends.md) — 工作区里那些 CLI 配置文件从哪来
