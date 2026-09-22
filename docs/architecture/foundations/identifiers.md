# 标识符体系

本页说明系统里每个 id 由谁生成、归属哪一层、什么时候重置，以及哪些 id 是有序的。

## 范围

覆盖：实体主键与执行身份的区别、各 id 的生成者、messageId 的形状、幂等键约定、有序 id、会话引用的归属。

不覆盖：表结构（见 [数据模型](./../backend/data-model.md)）、执行协议里的字段语义（见 [Agent Backend](./../execution/agent-backend.md)）。

## 实现文件

- `apps/backend/src/infra/ids.ts` — 全仓的 id 生成器
- `apps/backend/src/infra/db/schema.ts` — 主键与唯一索引
- `apps/backend/src/features/agent-run/adapter-sqlite-{enqueue,runs}.ts` — runId 与 messageId
- `apps/backend/src/features/agent-context/adapter-sqlite.ts` — treeId / branchId / entryId
- `packages/message/src/helpers.ts` — messageId 的三种形状
- `apps/backend/src/features/product-tools/{service,mcp}.ts` — 产品工具调用的身份

## 生成器

`ulid()` 实际上是 `crypto.randomUUID()` 去掉横线后截前 26 个字符。**它不是时间可排序的 ULID**，只是长得像；所以这些 id 没有顺序含义，也没有重置规则，全局随机。

全仓唯一用真正 `crypto.randomUUID()` 的地方是人类消息的 messageId。

id 生成是注入的：每个 service 收一个 `idGen`，测试里可以换成可预测的实现。

## 谁生成

| id | 生成者 |
|---|---|
| `runId` | 取 Run 的事务内，以及 follow-up 晋升时 |
| `inputId` | 入队前 |
| `entryId` | 追加 Context 引用时（取 Run、终态提交、`appendEntry`） |
| `treeId` | 对话首次出现时 |
| `branchId` | 建默认分支或分叉时 |
| `conversationId` | 对话服务 |
| `agentId` | 创建 Agent 时；调用方可以显式指定（种子 Agent 就是这么来的），但必须满足路径安全字符集 |
| `actionId` | 需要等待用户响应时（当前无生产调用方） |
| `callId` | 子进程发起产品工具调用时 |

## 两类 id

**实体主键**回答「这是谁」：`conversationId`、`agentId`、`projectId`、`branchId`、`entryId`。它们有的是注入生成的，有的（如 `agentId`）可以由调用方指定。

**执行身份**回答「这是哪一次执行」：`runId`。一次 Run 一个 `runId`，同分支同时只能有一个活跃 Run。`agent_run_id` 是账本上的列名，指的是同一个东西。

## messageId 的形状

Run 产出的消息只有三种形状：

- `run:<runId>:assistant:<序号>` — 最终回答的序号是**倒着数**的，所以最后一条是 `assistant:0`；
- `run:<runId>:tool:<下标>` — 工具结果；
- `run:<runId>:error` — 失败气泡。

人类消息是 `msg:<conversationId>:<sender>:<uuid>`，系统通知是 `sys:` 前缀。

## 有序 id

只有两个是真有序的，都是自增主键：

- `conversation_ledger.seq` — 对话内的共享顺序，**跨对话全局递增**，所以按它查必须同时带 conversationId；
- `branch_input_queue.seq` — 输入队列唯一稳定的排序键。

其他 id 都不可排序。

## 幂等键

约定是「一个基础键加用途后缀」：

| 用途 | 键 |
|---|---|
| 创建 Run | `<idempotencyKey>:run` |
| 投递输入 | `<idempotencyKey>:delivery` |
| 账本提交 | `(agent_run_id, message_index)` |
| 产品工具调用 | `(runId, callId)` 加输入哈希 |
| 待响应答复 | `response_idempotency_key` |
| 入队输入 | `(branch_id, input_idempotency_key)` |

对话侧的幂等键形如 `<conversationId>:<seq>:<agentId>`。唯一性都落在数据库索引上，不靠应用层记性。

## 会话引用

`agent_context_branch.cli_session_ref` 存的是子进程原生 session 的引用，带后端种类前缀（写的时候加，交给子进程之前剥掉）。

- oma：session 文件的路径 / session id（默认在 `~/.oma` 下，`OMA_CODING_AGENT_DIR` 可改）；
- claude：`--resume <session_id>` 用的 id；
- pi / omp：`--session <path>` 用的路径。

归属：**产品只写（从 outcome 回填）、只转发，从不解析它的内容**。它跟着分支走，不跟着 Run 走。

## 已经删掉的 id

`memberId`（多成员对话随 1:1 收敛删除）、`cronJobId`（`0042`）、`loopId`（`0043`）、`spanId` / `attemptId`（Phase 6，`0020`）都不存在了。`conversation_ledger.sender_member_id` 这个列名还在，但它取值是自由字符串（`user`、`__system__` 或 agentId），**不是外键**——列名是历史遗留。

## 不变量

1. `runId` 是唯一的执行身份。
2. 同一个分支同时只有一个活跃 Run。
3. `conversation_ledger.seq` 与 `branch_input_queue.seq` 是仅有的两个有序 id，且分别只在对话内、分支内解释。
4. 幂等靠数据库唯一索引，不靠应用层。
5. 会话引用跟分支走，产品不解释它。
