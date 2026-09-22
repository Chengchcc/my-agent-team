# Conversation History

Conversation History 是一场对话里共同发生的事实，存在账本 `conversation_ledger` 里，只追加。人发的消息与 Agent 提交的最终消息都进这里，所有端从它重放。Agent Context 只存指向它的引用。

## 范围

覆盖：账本存什么、人消息路径、Agent 消息提交路径、顺序与幂等、可见性过滤、实时更新与断线恢复。

不覆盖：Context 投影（见 [Agent Context](../agents/context.md)）、Run 生命周期与事件目录（见 [Run 输出与实时更新](../runs/output-and-live-updates.md)）、飞书的投递表（见 [飞书](../surfaces/lark.md)）。

## 实现文件

- `apps/backend/src/features/conversation/service.ts` — 除终态提交外的所有写入方，以及 SSE 流
- `apps/backend/src/features/conversation/adapter-sqlite.ts` — 账本读写、`undone`、搜索、预览
- `apps/backend/src/features/conversation/ledger-codec.ts` — 存储层 kind 枚举
- `apps/backend/src/features/conversation/http.ts` — REST 与 SSE 编码器
- `apps/backend/src/features/agent-run/adapter-sqlite-runs.ts` — 绕过 service 直接写账本的终态提交
- `apps/backend/src/bootstrap/features.ts` — `onRunCommitted` 把提交的 seq 推给 SSE 并落自动标题；`onRunFailed` 落失败气泡

## 存什么

存储层比线上多几种 kind：`message | member.joined | member.left | todo | surface.control | undo`。线上事件只认三种：`message | undo | surface.control`，`todo` 至今没有写入方。

实际存在的写入方只有五个：

- **人类消息**，`kind = "message"`，messageId 形如 `msg:<conversationId>:<sender>:<uuid>`；
- **Agent 终态提交**，一个 canonical 消息一行，带 `agent_run_id` 与 `message_index`；
- **Agent 失败气泡**，messageId 是 `run:<runId>:error`，`state` 为 `error`；
- **`surface.control`**，用于飞书的「开新对话」；
- **`undo` 标记**。

canonical 序列里包含工具消息（`run:<runId>:tool:<index>`），所以 tool_use 与 tool_result 真的躺在 History 里。

## 顺序与恢复

全局自增的 `seq` 就是共享顺序，所有读取都按 `seq` 升序。续读游标是 `afterSeq`，或者 SSE 的 `Last-Event-ID`。

## 幂等

Agent 行靠部分唯一索引 `(agent_run_id, message_index)` 加「冲突即忽略，再回读 seq」去重——一次完成的 Run 会写多行。Run 创建侧靠 `(branch_id, input_idempotency_key)` 与 `delivery_idempotency_key` 去重。

Context 引用的去重**不是**靠唯一键，而是提交事务里先按 `(tree_id, ledger_seq)` 读一遍再插。

## 原子性

账本行、Context 引用、分支 CAS、Run 状态 CAS 在一个事务里。

**人类消息不在这个事务里**：它先落账本，随后才单独创建 Run。中间断掉的话，账本里会留着一条没有对应 Run 的消息。

## 实时更新

推送式：写入后通知订阅者，另有 5 秒的轮询兜底；连续三次静默轮询就发一次心跳，带 `seq: 0` 与 `_heartbeat`。终态提交是通过「回读那一行再通知」进入 SSE 的。

通过 SSE 出去的事件只有三种 kind。`message` 行按 `MessageRevision` 解，其余 kind 作为 payload 走。

## 可见性

只有 `kind = "message"` 的行会进 Context，其中 `visibility = "internal"` 的在两处被丢弃：进 Context 的扫描，以及产品工具的读取。1:1 收敛之后不存在按成员的可见性，`visibility` 就是消息上的一个二值标记。

## 撤销、分叉与重放

三者都在对话层：

- **undo** 软删（`undone = 1`）并补一条 `undo` 账本行；
- **fork** 把 `seq <= fromSeq` 且未 undone 的行复制进一个新对话，带上分叉来源；
- **replay** 等于 fork(fromSeq - 1) 再加一条新消息。

三条路由都在 `conversation/http.ts` 里。

## 不变量

1. 账本只追加，`seq` 是对话内唯一顺序。
2. 端只渲染，不直接改 History；除终态提交这条受控路径外，写入都得经 Conversation service。
3. Agent 行与 Context 引用同事务提交。
4. 未被触发的 Agent 不会自动消费消息：引用只由取 Run 与显式 retain 追加。
5. 流式增量永不进账本。

## 已知缺口

- `kind: "todo"` 没有写入方，`member.joined` / `member.left` 同理（成员表已删）。它们在存储枚举里是历史残留。
- `commit_failed` 的 Run 在账本里**什么都不写**：既没有最终消息，也没有失败气泡。
