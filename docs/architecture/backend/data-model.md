# 数据模型

本页是 `backend.db` 的权威描述：哪些表是产品事实、哪些是执行控制面、哪些写入必须同事务、以及它们各自编码的幂等与不变式。drizzle schema 是唯一真相源。

## 范围

覆盖：表清单与分组、带语义的关键列、部分唯一索引与幂等键、终态提交事务、不变量、以及刻意不放进 SQLite 的东西。

不覆盖：查询 API 与 HTTP 形状（见 [Product Backend 总览](./overview.md)）、Workflow DSL 语义（见 [Agentic Workflow](../workflow.md)）、Artifact 的文件布局（见 [Agentic Workflow](../workflow.md#artifact)）、迁移历史逐条解读。

## 实现文件

- `apps/backend/src/infra/db/schema.ts` — 唯一真相源，21 张 `sqliteTable`
- `apps/backend/drizzle/backend/*.sql` 与 `meta/_journal.json` — 迁移，`0000` 到 `0048`
- `apps/backend/src/features/agent-run/adapter-sqlite-enqueue.ts` — 取 Run 的那个大事务
- `apps/backend/src/features/agent-run/adapter-sqlite-runs.ts` — 终态提交、失败提交、下一 Run 的晋升
- `apps/backend/src/features/{conversation,agent-context,product-tools}/adapter-sqlite.ts`
- `apps/backend/src/infra/sqlite/db.test.ts` — 迁移与约束的断言（表清单、被删的表、active run 索引）

lark-bot 有自己独立的库与 schema（四张表），与 `backend.db` 无关。

## 表清单

**产品事实**

| 表 | 存什么 |
|---|---|
| `agents` | Agent 的元数据；`config` 是工作区 `agent.yml` 的物化缓存，不是真相源 |
| `conversation` | 对话；`agent_id` 就是 1:1 参与关系（多成员时代的 `member` 表已随 1:1 收敛删除，见 `0037_conversation_agent_id.sql`） |
| `conversation_ledger` | 对话账本，唯一的消息事实 |
| `agent_context_tree` / `agent_context_entry` / `agent_context_branch` | Agent Context 的树、条目与分支 |
| `project` | 仓库级协作实体 |
| `skill_pack` / `agent_skill_pack` / `knowledge_pack` | 技能包与知识库及其绑定 |
| `settings` | 单行 KV，provider 配置也在这里 |

**执行控制面**

| 表 | 存什么 |
|---|---|
| `agent_run` | 一次产品执行；含模型引用、工作区、产品工具清单、系统提示、权限模式 |
| `branch_input_queue` | 待投递输入，按单调 `seq` 排序 |
| `pending_action` | 定义在案，但**没有生产写入方**（见下） |
| `product_tool_call` | 产品工具调用的幂等账 |
| `agent_run_event` | Run 级遥测，只落白名单里的事件类型 |

**Workflow 编排**

`workflow_execution`、`workflow_node_run`、`workflow_pending_human`、`workflow_execution_event`。

**审计与 KV**

`surface_health`、`settings`。


## 带语义的列与约束

**`conversation`**：`agent_id` 是 1:1 参与关系；`project_id` 外键 restrict；`fork_source` / `fork_from_seq` 记录分叉来源。

**`conversation_ledger`**：`seq` 自增主键，全局顺序就是它。`agent_run_id` + `message_index` 是提交身份——注意是**这一对**，不是 `agent_run_id` 单独唯一；一次完成的 Run 会提交多行（工具调用、工具结果、最终回答）。部分唯一索引 `idx_ledger_agent_run_message` 只对 `agent_run_id IS NOT NULL` 生效。`undone` 是软删标记。

**`agent_context_tree`**：每个对话一棵树，由 `idx_context_tree_conversation` 唯一约束保证；没有 per-member 维度。

**`agent_context_entry`**：`parent_id` 自引用，`type` 决定 `payload` 形状，`ledger_seq` 只对 `ledger_message` 有意义。注意 `(tree_id, ledger_seq)` **没有**唯一约束，去重是提交事务里的先读后插。

**`agent_context_branch`**：`leaf_entry_id`、`ledger_cursor`、`backend_kind`、`cli_session_ref`、`is_default`、`revision`。唯一索引 `idx_context_branch_default` 保证每棵树只有一个默认分支。

**`agent_run`**：`model_ref` 是 JSON，含请求时的配置快照；`idempotency_key` 唯一；`workspace_root` / `workspace_access` 记录这次跑在哪、什么权限；`product_tools` 是**一次性写入**的产品工具清单；`todo_snapshot` 承接上一次的 todo；`config_revision` 用于 CAS。部分唯一索引 `idx_agent_run_active_branch` 覆盖 `status IN ('running','waiting','commit_failed')`——**同一分支同时只能有一个活跃 Run**，这是数据库层的强制，与取 Run 时的应用层检查并存。

**`branch_input_queue`**：`seq` 单调，是唯一排序键；`input_id` 唯一；`status` 是 `pending | delivering | delivered | cancelled`，只有适配器接收后才会从 `delivering` CAS 成 `delivered`；请求时的模型、配置版本、工作区、系统提示、权限模式都快照在这一行里。两个幂等约束：交付幂等 `idx_queue_delivery_idem`，以及 `(branch_id, input_idempotency_key)` 唯一。

**`product_tool_call`**：主键 `(run_id, call_id)`，带 `input_hash`。重放返回已存结果，同样的 key 配不同输入直接失败。只读工具从不写这张表。

**`agent_run_event`**：`type` / `data` / `ts`，索引 `(run_id, seq)`。只落遥测白名单里的事件类型（`status`、`native_tool_started/completed`、`delegation_*`）；文本与 thinking 增量、以及全部 `backend.oma.*` 扩展事件都不落库。

## 必须同事务的写入

终态提交是唯一一处：账本行、Context 引用、分支 CAS、Run 状态 CAS，四件事在一个 `db.transaction` 里。没有引用的重放会跳过分支 CAS，其余照做。

**不在同一事务里的**：人类消息先落账本，随后才单独创建 Run。所以「人发了消息但 Run 没建起来」是一种真实存在的中断点，账本里留着那条消息。

## 幂等键

| 动作 | 键 |
|---|---|
| 创建 Run | `input_key:run` |
| 投递输入 | `input_key:delivery` |
| 账本提交 | `(agent_run_id, message_index)` |
| 产品工具调用 | `(run_id, call_id)` 加 `input_hash` |
| 待响应答复 | `response_idempotency_key` |
| 入队输入 | `(branch_id, input_idempotency_key)` 加 `delivery_idempotency_key` |

## 刻意不放进 SQLite 的东西

- Artifact：只在文件系统里（`projects/…` 之外，见 Artifact 一节）。
- MCP catalog：文件（`features/mcp/adapter-file.ts`）；`0027_mcp_catalog.sql` 里明确写了数据库里不再有 MCP 表。
- Agent 配置：工作区里的 `agent.yml` 是真相源，`agents.config` 只是缓存。

## 死表与死状态

`pending_action` 有表、有读写函数，但**没有生产调用方**（只有单测在调）。真实的审批走子进程的 `approval_request` 事件加 `POST /api/agent-runs/:runId/approval`，真实的提问走内存里的 resolver。后果是 `agent_run.status` 里的 `waiting` 在生产中不可达。

## 已经删掉的表

`backend_session_binding`（`0018`）、`mcp_server` 与 `mcp_server_legacy`（`0027`）、`agent_relationship`（`0026`）、多成员相关的 `member`（`0037`）、`trigger_mode` 列（`0038`）、`cron_job`（`0042`）、`loop_item` / `loop_budget`（`0043`），以及 Phase 6 清掉的 `span` / `attempt` / `control_plane_event` / `span_origin`（`0020_phase6_drop_legacy_execution.sql`）。`db.test.ts` 里对这些被删对象有断言，防止它们悄悄回来。

## 不变量

1. 账本 `seq` 是对话内唯一的顺序来源。
2. 一次完成的 Run 提交账本行、Context 引用、分支 CAS、Run CAS 四件事，全在一个事务里；提交身份是 `(agent_run_id, message_index)`。
3. 同一分支同时只有一个活跃 Run，由部分唯一索引强制。
4. `branch_input_queue.seq` 单调，是输入排序的唯一依据。
5. 产品工具调用以 `(run_id, call_id)` 幂等，只读工具不写幂等表。
6. `agent_run.product_tools` 一次写入不再改。
