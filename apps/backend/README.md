# backend

后端服务：产品事实（账本、Agent Context、Project、技能包、设置）与执行控制面都归它。它是个 Elysia HTTP/SSE 服务，浏览器与 Lark bot 只经由它读写状态、订阅事件；Agent Run 是唯一的执行身份，每个 Run 一个一次性 oma 子进程。

## 值得知道的约束

- **每个 Run 一个子进程**：产品只认 `AgentBackend` 协议，子进程自己的工具循环、重试、compaction 不进产品事实。
- **取 Run 是一个事务**：`enqueueAndAcquire` 一次事务里写队列行、做分支 CAS、读 `ledgerCursor` 之后的账本、追加 Context 引用、建 `agent_run`。
- **终态提交四件事同事务**：账本、Context 引用、分支 revision、Run 状态一起提交，失败走 `commit_failed`。
- **输入先落账本再建 Run**：两者不同事务，中间断掉会留下一条没有对应 Run 的人类消息。
- **恢复函数没有生产调用方**：`AgentRunExecutionService.recover()` 只在测试里被调，进程重启后 `delivering` 的输入与活跃 Run 要等该会话下一条消息才被清掉。
- **`commit_failed` 占住分支**：`retryTerminalCommit` 同样没有调用方，而 `commit_failed` 算活跃状态，分支不会被释放。

## 相关文档

- [Product Backend 总览](../../docs/architecture/backend/overview.md)
- [Conversation History](../../docs/architecture/conversation/history.md) · [Agent Context](../../docs/architecture/agents/context.md)
- [Run 输出与实时更新](../../docs/architecture/runs/output-and-live-updates.md)
- [AGENTS.md](./AGENTS.md) — 本 app 的命令、目录结构与编码约定
