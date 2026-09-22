# Run 输出与实时更新

一次 Agent Run 的子进程产出两样东西：一路 transient 事件流（会丢，用于实时渲染）和一个终态 `BackendRunOutcome`（唯一驱动产品提交的东西）。本页说明这两条路，以及取消、steer、follow-up 的实际行为。

## 范围

覆盖：子进程发什么、映射成什么、线上事件名、什么落库什么不落、终态提交（成功与失败）、取消、steer、follow-up、断线重连的语义。

不覆盖：子进程内部的循环与 compaction（见 [Oma Runtime](../runtime/oma.md)）、Workflow 节点事件（见 [Agentic Workflow](../workflow.md)）、token 用量端点、表结构（见 [数据模型](../backend/data-model.md)）。

## 实现文件

- `packages/agent-contract/src/run.ts` — `BackendRunInput`、`BackendRunOutcome`、`BackendRunSegment`
- `packages/agent-contract/src/event.ts` — `CoreBackendEvent` 与扩展事件
- `packages/adapter-oma-agent/src/event-mapper.ts` — 传输事件到核心事件的映射，以及 outcome 映射
- `packages/adapter-oma-agent/src/backend.ts` — spawn、接收、steer、stop、stdout 路由
- `apps/oh-my-agent/src/core/runtime/agent-event.ts` — 子进程自己的事件联合类型
- `apps/backend/src/features/agent-run/{execution-dispatch,execution-service,execution-live,execution-input,http}.ts`
- `packages/api-contract/src/sse.ts` — 线上事件 map 与端点注册表
- `apps/web/src/hooks/useConversation.ts` — 事实上的消费者，消费什么就是契约

## 子进程发什么

`agent_start` / `agent_end`、`turn_start` / `turn_end`、`message_start` / `message_update` / `message_end`、`thinking_update`、`tool_execution_start` / `tool_execution_end`（带 `kind: "native" | "product"`）、`tool_output`、`retry_start` / `retry_end`、`compaction_start` / `compaction_end`、`queue_update`、`mcp_mount_result`、`stream_rule_triggered`、`todo_update`、`delegation_*`、`delegation_agent_event`。

stdout 上是三类帧：`{id, type:"event", runId, event}`、`{type:"outcome", …}`、`{type:"response", …}`。

## 映射到线上事件

| 子进程事件 | 映射结果 |
|---|---|
| `message_update` | `text_delta` |
| `thinking_update` | `thinking_delta` |
| `tool_execution_start` / `_end` | `native_tool_started` / `native_tool_completed`（**不看 `kind`**，产品工具的 MCP 调用也走这里） |
| `agent_start` / `turn_start` / `turn_end` | `status` |
| `agent_end` | `status: completed \| failed \| aborted` |
| `delegation_*` | 对应的核心委派事件 |
| 其余（含 `approval_request`、`todo_update`、`mcp_mount_result`、`stream_rule_triggered`、`tool_output`） | `backend.oma.<事件名>` |

扩展事件这条路很关键：审批请求、todo 更新、ask 请求都是这么到达产品的。

线上事件的 `type` 就是 `ev.type` 原文，`id` 是 runId。`packages/api-contract/src/sse.ts` 的 `runEvents` 登记了 11 个事件名：`status`、`text_delta`、`thinking_delta`、`native_tool_started`、`native_tool_completed`、`backend.oma.todo_update`，以及五个 `delegation_*`（batch started / agent started / agent completed / batch completed / batch failed）。登记表之外的事件照样会流过去。对话侧的 SSE 只有三种：`message`、`undo`、`surface.control`。

Web 侧实际消费的是：`status`、`text_delta`、`thinking_delta`、`native_tool_started/completed`、`backend.oma.todo_update`、`backend.oma.stream_rule_triggered`、`backend.oma.approval_request`、`backend.oma.ask_requested`、以及 `delegation_*`。`status` 落在 `completed|failed|aborted|timeout` 时关闭或标红当前气泡。

## 什么落库，什么不落

**不落**：整个事件流本身。它只广播给进程内订阅者。

**落**：白名单里的事件类型（`status`、`native_tool_started/completed`、`delegation_*`）尽力写进 `agent_run_event`。文本与 thinking 增量、以及全部 `backend.oma.*` 扩展事件都不落库。

## 终态提交

**成功**：`settleOutcome` 后走 `commitCompletedRun`，在一个事务里完成（见 [数据模型](../backend/data-model.md)）。canonical 消息的 assistant 序号是**倒着数**的，所以最后那条回答是 `run:<runId>:assistant:0`；工具行是 `run:<runId>:tool:<index>`。若对话还没有标题，这时会把子进程给的标题落上。

**失败**：先广播带 error 的 `status` 事件，`onRunFailed` 落一条 `run:<runId>:error` 的用户可见消息，然后定终态与 `terminal_result`。outcome 里的 `cliSessionRef` 在任何终态下都会被保留。

**提交失败**：Run 变 `commit_failed`，什么都不写，分支继续被占。

## 取消

`POST /api/agent-runs/:runId/cancel`：Run 不存在 404，已是终态返回 `already_terminal`，非活跃 409，否则调 `stop()`——有活句柄就走子进程 abort（有限宽限后 SIGKILL），僵尸则直接终态化并晋升下一个输入。取消后 outcome 照常解析。

## 断线重连

`GET /api/agent-runs/:runId/events` 对晚到的订阅者按状态分派：

- 已 settled：发一个终态 `status` 后关闭；
- `commit_failed`：发 `status: failed`，不动 Run；
- 活跃且有活句柄或正在派单：正常订阅；
- 活跃但两者都不在（僵尸）：先 `abortStaleRun`，再发 `aborted`。

## steer 与 follow-up

**steer** 只对 oma 有意义。`injectSteer` 要求本进程上有活句柄，否则取消该输入并抛错；适配器发一条带唯一 id 的 steer RPC，30 秒响应超时。非 oma 种类在产品层就被改写成 `normal`；`mode: "steer"` 的输入如果到了派单却没有活 Run，是协议错误。

**follow-up** 在当前 Run 结束后由 `acquireNextRun` 晋升成一个全新 Run，用它自己那份配置快照。

**会话续接在 CLI 层**：outcome 的 `cliSessionRef` 带种类前缀存到分支上，下次 spawn 前剥回原始值传给子进程，子进程加载那个 session 文件作为种子历史；扁平的历史桥只在没有这个引用时才用。

## 边界与串行化

- 每次 Run 有墙钟上限（默认 30 分钟），到点 `stop()`。
- 同一个 worktree 的 Run 经 workspace lock 串行。
- 适配器按 `maxConcurrent` 做 spawn 槽位 FIFO。

## 契约上声明了但没人发的事件

`product_tool_started`、`product_tool_completed`、`pending_action` 三个事件在 `agent-contract` 里声明着，但**全仓没有任何地方发出它们**，线上事件表里也没有。产品工具的调用实际表现为 `native_tool_*`。

## 不变量

1. 终态 outcome 是唯一权威；outcome 之前的一切都不进产品事实。
2. 事件流是 transient，丢失不影响 Run 的结果。
3. 一个 Run 对应一个子进程；子进程崩溃由产品合成失败结果。
4. 只有三个终态能从 oma 到达：`completed`、`failed`、`aborted`；`timeout` 留给将来的后端。
5. 失败的 Run 会留下用户可见的错误消息；`commit_failed` 的不会。
