# Web 消息端到端

一句话：本页是 Web 端一条消息的权威端到端链路，从浏览器 POST 到 Web 收到 canonical 消息。人类行先落账本，随后一个事务完成入队、Context 引用同步与 run 创建，adapter 为这个 run spawn 一次性 oma 子进程，期间 Web 只看到 transient 事件流，终态 outcome 触发原子提交把 assistant 消息写回账本。

## 范围

覆盖：一次发送经过的每个边界（BFF、Conversation 服务、入队事务、dispatch、adapter spawn、run 事件流、终态提交、SSE 回推），以及失败矩阵与不变量。

不覆盖：oma 子进程内部的 model 与 tool 循环（见 [oma 运行时](../runtime/oma.md)）、账本与 Agent Context 的完整语义（见 [Conversation History](../conversation/history.md)、[Agent Context](../agents/context.md)）、飞书侧差异（见 [飞书消息端到端](./e2e-lark-message.md)）。

## 实现文件

- `apps/backend/src/features/conversation/http.ts` — `POST /api/conversations/:id/messages` 与 SSE 路由
- `apps/backend/src/features/conversation/service.ts` — `postMessage`、`#triggerForAgent`、订阅与心跳
- `apps/backend/src/features/agent-run/adapter-sqlite-enqueue.ts` — 入队与取得 run 的唯一事务
- `apps/backend/src/features/agent-run/execution-dispatch.ts` — 投影、`backend.execute`、终态结算
- `packages/adapter-oma-agent/src/backend.ts` 与 `process.ts` — spawn 与 JSONL 命令
- `apps/backend/src/features/agent-run/adapter-sqlite-runs.ts` — 终态提交事务
- `apps/backend/src/bootstrap/features.ts` — `onRunCommitted` 的即时推送与 `onRunFailed` 的失败气泡
- `apps/web/src/hooks/useConversation.ts` — 两条 SSE 的消费

## 端到端步骤

1. **发送**（`apps/web/src/features/conversations/hooks.ts` → `apps/web/src/lib/api.ts`）：`usePostConversationMessage` 组装 `{ content, mode, model }` 调 `api.postConversationMessage`，打到 BFF 的 `/api/bff/conversations/:id/messages`。`useConversation` 的 `send` 先派发乐观消息（id 为 `opt-<uuid>`，`seq = -1`）并把 `pendingSendCount` 加一；此时若有 run 在跑，请求带 `mode: "follow_up"`。
2. **BFF**（`apps/web/src/lib/bff.ts`）：去掉路径首段的 `api`，拼成 `<backend>/api/conversations/:id/messages`，把 cookie 换成 `x-auth-token` 与 `x-user-id` 后转发。
3. **写入人类行**（`apps/backend/src/features/conversation/service.ts` 的 `postMessage`）：先写账本再触发。人类 revision 的 `state` 固定为 `done`，`role` 为 `user`，messageId 由 `humanMessageId` 派生，`visibility` 写死 `conversation`。写入走 `#appendAndBroadcast`，它在同一处落库并通知该会话的 SSE 订阅者。
4. **触发判定**：`trigger = agentId !== null && (addressedTo ?? [agentId]).includes(agentId)`。HTTP 层返回 202 加 `{ seq, triggeredRuns }`，未触发时 `triggeredRuns` 为空数组。
5. **取 run**（`#triggerForAgent`）：取该会话的默认分支，查分支上是否已有 active run，据此定 mode（有 live 子进程是 `steer`，dispatch 在途是 `follow_up`，只剩 DB 记录是僵尸则 abort 后走 `normal`）；CLI 后端的 steer 一律降级为 `normal`。随后调 `AgentRunService.enqueueAndAcquire`，它派生 `<key>:delivery` 与 `<key>:run` 两个幂等键。
6. **入队与创建 run**（`apps/backend/src/features/agent-run/adapter-sqlite-enqueue.ts`，单个事务）：插一条 `branch_input_queue` 行（幂等键冲突时按 payload 判断是重放还是冲突），查分支上是否已有 active run，接着 CAS 分支 revision，读 `ledgerCursor` 之后且未 undone 的账本行，过滤掉 `visibility === "internal"` 与非 `message` 行，取最后 20 条，逐条插 `agent_context_entry(type = "ledger_message")`，推进 `ledgerCursor` 与 `leafEntryId`，创建 `status = "running"` 的 `agent_run`，把队列行标 `delivering`。
7. **派发**（`#dispatchRun` → `execution-dispatch.ts`）：`assertModelAvailable` 先校验模型在 catalog 里可用，`claimInputForRun` 认领输入，`projectHistory` 做全量投影（没有增量 resume），按分支与 workspace 取锁，然后调 `backend.execute`。
8. **spawn 子进程**（`packages/adapter-oma-agent/src/backend.ts`）：等一个并发槽位，用 workspace 根目录作 cwd、白名单 env 加本次 run 的 product tools token 起进程，向 stdin 写一行 `{ id, type: "execute", input }`，并等 acceptance。handle 在写命令之前注册，steer 与 stop 才能立刻路由。
9. **子进程期间**（agent-run 的事件流）：`mapRunEvent` 把子进程事件映射成 `BackendEvent`，`execution-live.ts` 的 `forwardEvents` 广播给当前进程的订阅者。这条流不落库（只有 telemetry 类型会落 `agent_run_event`）。Web 的 per-run EventSource 打的是 `/api/bff/agent-runs/:runId/events`，事件名单见 [Web 端](../surfaces/web.md)。
10. **终态**（`adapter-oma-agent` 的 outcome 到 `execution-dispatch.ts` 的 `settleOutcome`）：子进程写 `{ type: "outcome" }` 后 adapter 映射出 `BackendRunOutcome`。`status === "completed"` 进提交事务，其它终态广播一条 `status` 事件、调 `onRunFailed`、走 `finalizeRun`。
11. **原子提交**（`apps/backend/src/features/agent-run/adapter-sqlite-runs.ts` 的 `commitCompletedRun`，单个事务）：只接受 `completed`，already-completed 直接返回（重放幂等），校验分支归属，用 `normalizeCanonicalMessages` 归一化后按 `(agent_run_id, message_index)` 一行一条写账本，assistant 的 messageId 由 `assistantMessageId(runId, n)` 生成且 `state` 固定 `done`，工具消息 id 形如 `run:<runId>:tool:<index>`，同时追加 `ledger_message` 引用、推进分支 leaf 与 revision、把 run 标 `completed`。
12. **即时回推**（`apps/backend/src/bootstrap/features.ts` 的 `onRunCommitted`）：提交事务绕过 Conversation 服务直接写库，所以这里对每个提交的 seq 调 `notifySeq`，向在线订阅者立刻推一帧。没有这一步，canonical 消息要等 `subscribeConversation` 的 5 秒轮询兜底，表现为 run 流关闭后的一段空白帧。
13. **Web 收尾**：conversation SSE 的 `message` 帧到达后，`useConversation` 用 `^run:([^:]+):` 匹配 messageId 丢掉同一 run 的临时气泡，再把解析后的 revision 派发给 reducer，按 messageId upsert 进 `items`。

## steer 与排队

steer 与 follow-up 都先落 `branch_input_queue`。steer 属于当前 active run，走 `#injectSteer` 立刻注入 live 子进程，没有 live 子进程时在入队阶段被标 `cancelled`，不会被重放成普通输入。follow-up 等当前 run 终态后由 `acquireNextRun` 提升为新 run，新 run 用队列行自己的配置快照，不用上一个 run 的。子进程内部的 sub-agent 不创建额外的 Agent Run。

## 失败与恢复

| 场景 | 行为 |
|---|---|
| Web 断线 | conversation 流全量重放加 waterline 去重；run 流靠 2 秒轮询 `listAgentRuns` 重新开流 |
| 派发前失败（模型不可用、投影抛错、spawn 失败） | run 被终结为 `failed`，绑定输入取消，订阅者关闭，广播一条带错误文案的 `status`，并由 `onRunFailed` 落一条 `run:<runId>:error` 的账本行 |
| 子进程崩溃或 stdout 协议损坏 | 同上，错误详情来自脱敏后的 stderr 尾部 |
| 提交失败 | run 停在 `commit_failed` 并保存 outcome，启动恢复时 `retryTerminalCommit` 用存下来的 outcome 重放提交，不重新执行；这条路径不写任何账本行 |
| backend 重启 | 已投递输入但没有活动子进程的 run 直接终结为 `aborted`（子进程无状态，不能续跑），随后提升队列里的下一个输入 |
| streaming 丢帧 | 不影响账本；canonical 消息仍然从 conversation 流到达 |

## 不变量

1. 人类行先落账本才触发 run，中间断掉会留下一条没有对应 run 的账本消息。
2. 同一分支同时最多一个 active run；run 状态本身就是锁，队列行的提升由它决定。
3. 账本与 Context 引用由同一个事务提交，终态提交还包含分支更新与 run 状态。
4. `BackendRunOutcome` 是终态的唯一依据，事件流不能决定 terminal state。
5. streaming 不是 canonical history：临时气泡要么被账本行替换（assistant 行或 `run:<runId>:error` 失败行），要么停在原地等下一次刷新。
6. Agent Run 是唯一执行身份，子进程状态可以丢，Context 不可以。

## 相关页

- [Web 端](../surfaces/web.md)
- [Conversation History](../conversation/history.md)
- [Run 输出与实时更新](../runs/output-and-live-updates.md)
- [Agent Context](../agents/context.md)
- [Agent Backend](../execution/agent-backend.md)
- [排障指南](../operations/troubleshooting.md)
