---
title: 排障指南
description: 按端、BFF、backend、adapter、子进程、工作区分层定位故障的症状对照表与最短诊断日志观察链
tags: [backend, runtime, surfaces]
---

# 排障指南

一句话：本页是按层定位故障的权威手册。先判断症状出现在哪个层（端、BFF、backend、adapter、子进程、工作区），再按该层的对照表定位到代码位置。

## 范围

覆盖：分层判据与逐层症状对照，事实层、执行层与投影层的区分，诊断日志怎么开、最短观察链长什么样，打包产物起不来时怎么判，以及今天仍然成立的系统级不变量。

不覆盖：飞书端的实现细节（见 [飞书](../surfaces/lark.md)）、Web 端的渲染细节（见 [Web 端](../surfaces/web.md)）、Agent Run 的完整状态机（见 [Run 输出与实时更新](../runs/output-and-live-updates.md)）。

## 实现文件

- `apps/backend/src/infra/db/schema.ts` — 事实层与执行层各表的权威定义
- `packages/agent-contract/src/debug.ts` — `debugLog` 与 `OMA_DEBUG=1`，子进程继承同一个开关
- `apps/backend/src/features/agent-run/execution-dispatch.ts` — 阶段名与 `dispatch_failed`
- `apps/backend/src/features/agent-run/execution-service.ts` — 启动恢复、`retryTerminalCommit`、非 completed 终态
- `apps/backend/src/features/conversation/service.ts` — `[conversation] trigger` 行与 5 秒轮询兜底
- `apps/backend/src/http/response.ts` — SSE 构造，心跳与「没有 done 事件」
- `apps/web/src/hooks/useConversation.ts` — 浏览器侧两条 SSE 的真实路径
- `scripts/pack-gateway.sh` — 产物的布局、pty 库的落位，以及打出包后自己跑一次 `/health` 的 boot smoke

## 先分层

事实层是产品真相，坏了会影响所有端：`conversation_ledger`（对话历史）与 `agent_context_*`（Agent Context）。

执行层决定某个 Run 的终态：`agent_run`、`branch_input_queue`、`pending_action`、`product_tool_call`。

投影层只影响某个端看到的画面：per-run 事件流、SSE 连接、子进程的 stderr。这一层没有真相，重连或刷新就重建。

## 端

| 症状 | 先看 | 代码位置 |
|---|---|---|
| 对话页消息不出现 | conversation SSE 是否连着，顶部有没有 reconnecting 提示条 | `apps/web/src/components/ConversationCanvas.tsx` |
| 页面刷新后看不到历史 | 全量重放是否被 waterline 去重挡掉 | `apps/web/src/hooks/useConversation.ts` 的 `guard` |
| 同一句话显示两条 | 乐观消息的 `opt-` 替换是否命中 | `apps/web/src/lib/conversation-reducer.ts` 的 `upsertAuthoritative` |
| 有 run 在跑但页面停在空闲 | per-run 流没接上，2 秒轮询是否命中 `running` / `waiting` / `commit_failed` | `useConversation.ts` 的 run 追踪 |
| 文本在流但最后一条消息没替换 | canonical 行的 messageId 前缀是否匹配 `^run:<runId>:` | `useConversation.ts` 的 `message` 订阅 |
| 飞书没收到回复 | `message_delivery` 是否已记意图、`chat_binding.pushed_seq` 是否推进 | `apps/lark-bot/src/sse-watcher.ts`、`bindings-sqlite.ts` |
| 飞书机器人不响应 | `allowed_senders` 是否含该用户，群聊是否 @ 到机器人 | `apps/lark-bot/src/ingest.ts` |
| 飞书回复重复 | 重连重放时 `message_delivery` 的终态判断 | `sse-watcher.ts` 的 `processEntry` |
| 飞书收不到新会话的消息 | `chat_binding` 是否被 `surface.control` 重绑到了别的会话 | `bindings-sqlite.ts` 的 `rebindChatConversation` |

## BFF

Web 的 REST 与 SSE 都经 Next 的代理转发（`apps/web/src/lib/bff.ts`），排障时注意两点：

- 路径首段是 `api` 会被去掉，所以 `/api/bff/api/conversations/...` 与 `/api/bff/conversations/...` 都到同一个后端路由。
- SSE 请求不带 `req.signal`，因为 Next 开发模式的 abort 会掐掉上游流。浏览器 Network 里应同时看到 `/api/bff/conversations/:id/events?afterSeq=0` 与 `/api/bff/agent-runs/:runId/events` 两类请求。

BFF 只做 cookie 换 `x-auth-token` 与 `x-user-id`，不解析业务载荷；鉴权失败时先确认这两个头是否发出。

## backend

| 症状 | 先看 | 代码位置 |
|---|---|---|
| 某个端看不到本该有的消息 | 账本里该 conversation 的行，以及订阅者是否收到 | `apps/backend/src/features/conversation/service.ts` |
| 所有人都缺同一条消息 | Run 是否停在 `commit_failed`，子进程是否没产出消息 | `apps/backend/src/features/agent-run/adapter-sqlite-runs.ts` |
| Run 卡在 running 不动 | 输入是否停在 `delivering`；子进程是否崩溃但 outcome 未到 | `execution-dispatch.ts`、`adapter-sqlite-enqueue.ts` |
| Run 停在 waiting | 是否有一条未决 `pending_action` | `apps/backend/src/features/agent-run/adapter-sqlite-actions.ts` |
| 输入发了但没执行 | `branch_input_queue.status`，分支上是否已有 active run | `adapter-sqlite-enqueue.ts` |
| 同一输入被执行两次 | 幂等键（input / delivery 两组）是否命中重放分支 | `adapter-sqlite-enqueue.ts` |
| 提交失败后无法继续 | `commit_failed` 的 Run 是否被 `retryTerminalCommit` 重试过 | `execution-service.ts` |
| backend 重启后 Run 凭空结束 | 启动恢复把已投递输入的孤儿 run 终结为 `aborted`，这是预期行为 | `execution-service.ts` 的 `recover` |
| SSE 流自己断开并出现 error 帧 | 账本里是否出现了没有对应 wire schema 的 kind | `apps/backend/src/features/conversation/http.ts`、`packages/api-contract/src/sse.ts` |

## adapter

adapter 是 oma 子进程的进程管理与 JSONL 控制器（`packages/adapter-oma-agent/src/backend.ts`）。

| 症状 | 先看 | 位置 |
|---|---|---|
| Run 立即失败并提到 spawn | 可执行文件是否存在、并发槽位是否被占满 | `spawnOmaProcess` 与 `acquireSlot` |
| 子进程拒绝 execute | 请求构造是否合法，`invalid_request` 会带子进程的拒绝原因 | `handle.acceptance` |
| 子进程崩溃 | 错误详情里的 stderr 尾部，它是脱敏后的截断内容 | `packages/adapter-oma-agent/src/stderr-tail.ts` |
| stdout 协议损坏 | `failProtocol` 路径，一条坏行就会终结该 Run | `consumeStdout` |
| 审批点了没反应 | 该 run 在本进程里是否还有 live 子进程，以及 backend 是否有 approval 管道 | `execution-service.ts` 的 `resolveApproval` |
| steer 报 no live child | steer 只注入 live 子进程，run 已终结时输入会被取消 | `backend.ts` 的 `steer` |
| 停不下来的 Run | abort 有宽限期，超时后直接杀进程并 settle 为 aborted | `backend.ts` 的 `stop` |

## 子进程

子进程是 `oma` 的一次性 RPC 进程，一个 Run 一个进程，退出来就不再复活。

| 症状 | 先看 | 位置 |
|---|---|---|
| 所有 Run 都在 preflight 失败 | 模型列表接口是否可用，模型 id 是否在 catalog 里 | `execution-dispatch.ts` 的 `assertModelAvailable` |
| Run 跑满时限被中止 | 看门狗按 `runTimeoutMs` 调 `stop` | `execution-dispatch.ts` 的 `watchdog` |
| coding 面板里的 oma 用不了 product tools | 该 oma 由按钮注入，没有 Run Token | `apps/backend/src/features/coding/http.ts` 的 `launch-oma` |
| 面板状态点不变 | `.oma/agent-status.json` 是否在写、心跳是否超过 3 分钟 | `apps/backend/src/features/coding/agent-status.ts` |

## 工作区

| 症状 | 先看 | 位置 |
|---|---|---|
| 首次点击提示 worktree 冲突 | 目录被普通目录占用，`ensureWorktree` 拒绝覆盖 | `apps/backend/src/features/project/worktree.ts` |
| 两个 Run 不能同时跑 | 同一 workspace 上的锁把 Run 串行化，这是设计 | `execution-dispatch.ts` 的 `workspaceLocks` |
| 终端 spawn 报 422 | `worktreePath` 不在该 agent 的主 worktree 或任务 worktree 里 | `apps/backend/src/features/coding/task-worktrees.ts` |
| 删除任务 worktree 返回 409 | 该路径还有 running 的终端 | `apps/backend/src/bootstrap/features.ts` 的删除入口 |
| 终端面板重启后少了一个 | 快照重建时 agent 或 project 已不存在，条目被修剪 | `features.ts` 的 boot 恢复与 `registry.sync()` |

## 打包产物

产物（`oma gateway up` 装的那份）与仓库里的开发启动是两条路：开发时 backend 直接读源码与 `node_modules`，产物是 bundle 加一份固定布局。所以「本地好好的，产物起不来」几乎都是布局问题，不是代码问题。

| 症状 | 先看 | 位置 |
|---|---|---|
| 产物启动即退，日志里 `librust_pty shared library not found` | 这份包是缺库的旧产物（bun-pty 的预编译库没被打进去）；用当前脚本重打一次 | `scripts/pack-gateway.sh` 的 pty 段 |
| 产物 backend 打印了 listening 随即退出 1 | 往上翻有没有 `[bootstrap] model cost catalog failed`：`oma --list-models` 的输出不是合法 JSON（`OMA_BIN` 指向别的程序、oma 版本不匹配） | `apps/backend/src/bootstrap/features.ts` 的 `modelCosts` |
| 打包脚本在 boot smoke 就失败 | 产物真的起不来，失败信息上方就是它自己的启动日志 | `scripts/pack-gateway.sh` 的 boot smoke 段 |
| 打包脚本说 native leaked in | 除 bun-pty 的库目录外，产物里不该出现 `.so`/`.dylib`/`.node`/`.dll`；那份多出来的东西就是泄漏源 | 同上，native 检查 |

## 诊断日志

`OMA_DEBUG=1` 是唯一的开关（`packages/agent-contract/src/debug.ts`），子进程继承同一变量，所以一次开启能同时点亮 backend、adapter、子进程 RPC 与 model loop 的日志。日志只含阶段名、id、计数与状态，不含消息正文、工具输入、prompt 与密钥。child 的 stderr 会保留一份脱敏尾部，但它只在协议失败时拼进错误详情，不做实时转发。

最短观察链（缺哪一行，故障就落在上一行与下一行之间）：

```text
[conversation] trigger conversationId=... agentId=... branchId=... mode=... inputId=... runId=... acquired=true queued=false
[agent-run] model_preflight_ok runId=... model=...
[agent-run] context_projected runId=... entries=N
[agent-run] backend_execute runId=...
[oma-adapter] spawned runId=... pid=...
[oma] loop_live runId=...
[oma] model_start runId=... turn=1 model=...
[oma-adapter] outcome runId=... status=completed
[agent-run] outcome runId=... status=completed
[agent-run] terminal_commit runId=... messages=N
```

失败会带阶段名，stage 取值来自 dispatch 内的阶段标记（`load_run`、`model_preflight`、`claim_input`、`resolve_workspace`、`set_product_tools`、`context_projection`、`backend_execute`、`settle_outcome`、`acquire_next`）：

```text
[agent-run] dispatch_failed runId=... stage=context_projection Error: ...
```

tag 的含义：`conversation` 是触发与入队，`agent-run` 是执行生命周期，`oma-adapter` 是 spawn、JSONL 与回收，`oma` 是子进程内部的 RPC 与 model loop。

## 两条 HITL 通道

审批与问答都走 per-run 事件流，卡在 `waiting` 时先看这两条链：

- `backend.oma.approval_request`（web 渲染审批卡片）→ `POST /api/agent-runs/:runId/approval`（body 是 `{ callId, decision }`，run 已终结返回 409，body 不合法返回 400，run 不存在返回 404）。
- `backend.oma.ask_requested`（web 渲染问答卡片）→ `POST /api/product-tools/ask/resolve`，超时时间默认 60 秒，超时按未回答返回 null。

## 不变量

1. Agent Run 是唯一执行身份。按 spanId 或 sessionId 查询的代码路径已经不存在，对应表也已删除。
2. `BackendRunOutcome` 是终态的唯一依据，事件流不能决定 terminal state。
3. terminal commit 是原子的：assistant 消息加 Context 引用加分支更新加 Run 终态在同一个事务里，失败则 Run 停在 `commit_failed` 等幂等重试。
4. 账本是唯一的对话事实来源。任何端与账本不一致时，错的是端的投影。
5. 子进程无状态：崩溃等于当前 Run 失败，下一个输入是新 Run，从 Agent Context 全量投影重建。
6. per-run 事件流不落库，只落 telemetry 类型的事件到 `agent_run_event`。
7. conversation SSE 不发 `done` 事件，靠心跳与连接中止表达生命周期。
8. 产物必须自证能启动：`scripts/pack-gateway.sh` 打完包会从干净工作目录启动一次 backend 并要求 `/health` 应答，过不了就不产出 tar。凡是「打包成功但用户起不来」，都是这条自检没覆盖到的东西。

## 已知缺口

- 存储层的 kind 枚举里还留着 `member.joined`、`member.left`、`todo`，但没有写入方。一旦有行以这些 kind 落库，SSE 编码器找不到对应 schema 会抛错，表现为该条流断开并出现一帧 `event: error`。
- `role: "tool"` 的账本行不被飞书端过滤，会原样投递；Web 侧则按 `isConclusionMessage` 排除在气泡之外。
- 失败气泡只覆盖 `onRunFailed` 的调用路径：停在 `commit_failed` 的 run 与启动恢复时被终结为 `aborted` 的孤儿 run 在账本里什么都不写。

## 相关页

- [事实与投影](../foundations/facts-and-projections.md)
- [Run 输出与实时更新](../runs/output-and-live-updates.md)
- [后端总览](../backend/overview.md)
- [Web 消息端到端](../flows/e2e-web-message.md)
- [飞书消息端到端](../flows/e2e-lark-message.md)
