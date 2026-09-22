# Web 端

一句话：本页是 Web 端的权威描述。Web 端是浏览器里的对话界面 `/chat/[id]` 加 worktree 终端页 `/coding`。对话页把 conversation SSE 的账本行 upsert 进 `items[]`，把 per-run SSE 渲染成临时气泡，两者靠 messageId 对账。终端页持有 backend 进程里的裸 PTY。

## 范围

覆盖：对话页的渲染模型（ConvState、reducer 的 action 名单、纯函数），两条 SSE 的准确事件名单，busy 的推导，Timeline 锚点规则，错误与断线展示，`/coding` 的鉴权、生命周期、状态点与 worktree 双轴。

不覆盖：账本与 Run 的后端语义（见 [Conversation History](../conversation/history.md)、[Run 输出与实时更新](../runs/output-and-live-updates.md)）、agent 配置页与 workflow 编辑器等其他前端页面、BFF 代理的完整实现（只在需要时提 `apps/web/src/lib/bff.ts`）。

## 实现文件

- `apps/web/src/hooks/useConversation.ts` — 两条 SSE 的消费、临时态、busy
- `apps/web/src/lib/conversation-reducer.ts` — ConvState 与 reducer 纯函数
- `apps/web/src/lib/typed-source.ts` — EventSource 加 zod 校验的封装
- `apps/web/src/lib/bff.ts` — Next BFF 代理，cookie 换成 `x-auth-token`
- `apps/web/src/lib/transient-reducer.ts` — 临时气泡、工具步骤、todo、审批与问答
- `apps/web/src/components/Timeline.tsx` — turn 分组与滚动锚点
- `apps/web/src/components/ConversationCanvas.tsx` — 头部状态标签、错误条、Stop
- `apps/web/src/features/coding/components/{coding-page,coding-rail,terminal-pane,split-view}.tsx` — 终端页 UI
- `apps/backend/src/features/coding/{http,terminal-registry,agent-status,task-worktrees}.ts` — 终端页后端

## 对话页的渲染模型

`ConvState` 只有六个字段（`apps/web/src/lib/conversation-reducer.ts`）：

| 字段 | 含义 |
|---|---|
| `agent` | 本会话的 agent，`bootstrap` 时从 `ConversationSnapshot.agentId` 写入 |
| `items` | 渲染列表，`UiItem` 是 `{kind:"message", id, sender, content, seq, undone?}` 或 `{kind:"notice", id, text}` |
| `streamConn` | `connecting` / `open` / `reconnecting` / `closed` |
| `error` | 发送失败的文案 |
| `pendingSendCount` | 已本地派发但还没 settled 的 POST 数 |
| `optimisticSeq` | 客户端消息 id 的序号字段，目前只有声明与初值 `0` |

reducer 的 action 名单是 `bootstrap`、`send`、`send/settled`、`conn`、`send/error`、`member`、`message`、`undo`。其中 `member` 只有类型没有分支，落进 `default` 被静默丢弃。

三个纯函数决定渲染分组：

- `upsertAuthoritative` — 同 id 就地替换；没有同 id 且 sender 是人时，替换最近一条 `opt-` 前缀消息；再否则追加。
- `isConclusionMessage` — `role === "tool"` 返回 false，含 `tool_use` block 返回 false，有非空 text 返回 true，纯 thinking 骨架返回 false。
- `groupTurns` — 连续同 agent 的消息收成一个 turn，最后一条 conclusion 进 `conclusion`，其余进 `rounds`。

`role` 是唯一的作者判据：`user` 归人类侧，`assistant` 与 `tool` 归 agent 侧，`system` 进 notice 而不是气泡。

## 两条 SSE

对话流是 canonical 输入，URL 为 `/api/bff/conversations/:id/events?afterSeq=0`（`apps/web/src/hooks/useConversation.ts`）。每次挂载都全量重放，页面刷新因此能看到完整历史；重连走 `Last-Event-ID`，重放靠 `guard` 去重（水位线加 256 条滑窗，丢帧时弹一次「Reconnected — syncing missed messages」）。

对话流上只订阅两个事件：

- `message` — 帧里带 `message` 才处理，否则当心跳或旧行跳过。messageId 命中 `^run:([^:]+):` 时，说明这个 run 的 canonical 行到了，丢掉该 run 的临时气泡。
- `undo` — 从 `payload.undoneSeqs` 取序号，把对应 `items` 标 `undone`（灰显）。

`surface.control` 在事件表里但没有订阅者，Web 不处理。连接没有 idle timeout，后端在连续静默轮询后发 `: ping` 注释帧。

per-run 流是 `/api/bff/agent-runs/:runId/events`（路径来自 `sseEndpoints.agentRunEvents`），每个 run 一条 EventSource。`useConversation.ts` 注册的事件名如下：

| 事件名 | 用途 |
|---|---|
| `status` | 终态判定：`completed` 收尾，`failed` / `aborted` / `timeout` 留气泡并挂错误 pill |
| `text_delta` | 追加临时气泡正文 |
| `thinking_delta` | 追加临时思考块 |
| `native_tool_started` / `native_tool_completed` | 工具步骤起止，`todo_write` 的 result 归一化后进 todo 面板 |
| `backend.oma.todo_update` | 直接替换该 run 的 todo 快照 |
| `backend.oma.stream_rule_triggered` | 推一条「规则命中，输出丢弃重试」的提示 |
| `backend.oma.approval_request` | 渲染审批卡片 |
| `backend.oma.ask_requested` | 渲染问答卡片 |
| `delegation_batch_started` / `delegation_agent_started` / `delegation_agent_completed` / `delegation_batch_completed` | workflow 进度面板 |

注册表里还有 `delegation_batch_failed`，Web 不订阅（`packages/api-contract/src/sse.ts`）。

本地发送之外的 run 靠追踪补上：每 2 秒轮询 `api.listAgentRuns({ conversationId })`，对 `running`、`waiting`、`commit_failed` 且还没开流的 run 调 `watchRun`。

## busy 的推导

state 里的 busy 只看发送在途：

```ts
export function isBusy(s: ConvState): boolean {
  return s.pendingSendCount > 0;
}
```

hook 层再并上在跑的 run 集合：`busy = isBusy(state) || activeRuns.size > 0`。`activeRuns` 里的 runId 在终态事件到达、流被关闭或用户切换会话时清空。发送时若 `isBusy(state) || activeRuns.size > 0`，请求带 `mode: "follow_up"`，进入排队而不是当作 steer 注入。

头部标签（`apps/web/src/components/ConversationCanvas.tsx`）按优先级取：有 `state === "waiting"` 的 agent 消息显示 "Awaiting approval"；最近一条 agent 消息带 `runStatus` 时显示 "Retrying…" 或 "Compacting context…"；否则 busy 时显示 "Running"。

## Timeline 锚点

`groupTurns` 先分段，`extractAnchors`（`apps/web/src/components/Timeline.tsx`）只在 `isTurnStart` 处建锚，锚 id 是 `turn-<segmentId>`，编号按锚出现顺序自增。`isTurnStart` 的规则（`apps/web/src/lib/conversation-reducer.ts`）：notice 永远不起 turn；human 消息一定起 turn；会话里存在 human 段时，agent 段不起 turn，纯 agent 会话才用 sender 变化兜底，且首段起 turn。滚动用一个 `rootMargin: "-10% 0px -80% 0px"` 的 IntersectionObserver 更新当前锚。

## 错误与断线展示

`streamConn` 为 `reconnecting` 或 `closed` 时顶部出现一条提示条，`closed` 时附一个 Reconnect 按钮（整页重载）。`state.error` 非空时出现错误条，带 Retry 按钮，重发上一条人类消息。busy 且有活跃 run 时头部出现 stop 与 abort，它们调 `api.cancelAgentRun(currentRunId)`；`currentRunId` 取自 `activeRuns` 集合，不从消息状态推断。

## Coding 页（worktree 终端）

`/coding` 是 project 与 worktree 的终端宿主，与对话页彻底分离。侧边栏入口在 `apps/web/src/components/NavRail.tsx`。页面结构是左栏 `coding-rail.tsx`（projects 与 worktrees 拍平成一个列表，行上带汇总状态点）、右栏 tab 条加终端。tab 条右侧 `Columns2Icon` 切换 `SplitView` 并排（偏好写 `localStorage` 的 `coding-split`）；pane 头部有「oma」按钮（`terminal-pane.tsx`）向该 pane 注入 oma 命令行，旁边是重启按钮。

鉴权分两条路：REST 走 BFF（cookie 换 `x-auth-token`）；终端字节流绕开 BFF 直连 backend，因为 Next 的 route handler 代理不了 WebSocket。`POST /api/coding/ws-ticket` 铸一张一次性票（32 字节随机、TTL 60 秒、取出即删），浏览器用 `wsBase` 拼 `ws://host:port/ws/coding/:id?ticket=` 连接；`wsBase` 把 `0.0.0.0` 与 `::` 换成 `127.0.0.1`（`apps/backend/src/bootstrap/features.ts`），全局 authGuard 只豁免 `/ws/` 前缀，票在 ws 的 `open` 里校验。

生命周期是 tmux 语义，PTY 归 backend 进程（`apps/backend/src/features/coding/terminal-registry.ts`）：

- WS 断开只 detach，进程继续跑。
- `DELETE /api/coding/terminals/:id` 是 kill-pane，前端对活进程先弹确认（`coding-page.tsx` 的 `requestClose`）。
- 进程死后留遗容，ring buffer 上限 40 万字符，`respawn` 复用上次 dims。
- `kind === "oma"` 的 pane 用 `bash -c "<oma> --continue; exec bash"` 复活，oma 退出落回 shell。
- backend 重启会杀掉全部子进程，boot 时按持久化快照重建，重建不了的条目先跳过再由 `sync()` 修剪。

pane 默认是 `/bin/bash`，oma 是显式注入：`POST /api/coding/terminals/:id/launch-oma` 把解析好的命令行写进 pane 并标 `kind = "oma"`；pane 已退出时返回 409。这条 oma 没有 Run Token，product tools 不可用。

状态点由 oma TUI 的 `.oma/agent-status.json` 驱动：写方是 `apps/oh-my-agent/src/modes/tui/agent-status.ts`（`working` / `blocked` / `idle`，运行中每 60 秒心跳），读方是 `apps/backend/src/features/coding/agent-status.ts`，超过 3 分钟没心跳返回 null。终端接口只在 `kind === "oma" && status === "running"` 的 pane 上聚合 `agentState`。前端 `terminalDot` 映射四态：`exited` 是空心 ○，`blocked` 是琥珀 ◉，`working` 是脉动 ●，`idle` 是深绿 ○，没有 agentState 的壳 pane 是绿色 ●。

worktree 双轴：主 worktree 是 `(agent × project)` 的 attach 产物，缺失时在 spawn 时现场物化；任务 worktree 是 `<projectId>.<slug>` 形态的显式 checkout，slug 匹配 `^[a-z0-9][a-z0-9-]{0,39}$`，有独立的创建与删除入口，删除前要求该路径没有 running 的终端。终端的 `worktreePath` 必须过 `validateWorktreePath` 的前缀白名单（`apps/backend/src/features/coding/task-worktrees.ts`），只认该 agent 的主 worktree 或它的任务 worktree。

## 失败模式

- 乐观消息残留：账本回声丢了 `opt-` 消息不会被替换；messageId 对不上时同一句话显示两条。
- 临时气泡不替换：run 流提前关闭但 canonical 行还没到，页面留一个空白帧直到账本行到达。
- 失败行的时序：`failed` / `aborted` / `timeout` 的 run 会被 `onRunFailed` 写一条 messageId 为 `run:<runId>:error` 的账本行，它同样匹配 `^run:<runId>:` 前缀，因此到达时会把带错误 pill 的临时气泡替换掉；在它到达之前，pill 是唯一的失败记录。停在 `commit_failed` 的 run 没有这条行。
- 轮询抖动：run 追踪的 effect 依赖不稳定时会反复重建 2 秒 interval。

## 不变量

1. 对话历史的唯一 canonical 输入是 conversation SSE，run 流只产生临时气泡。
2. 临时气泡的生命周期不超过它对应的 run：canonical 行到达时被丢弃，失败运行的气泡留到刷新。
3. 每个 run 只有一条 run 流，runId 由后端生成。
4. 终端字节流不经过 BFF；票一次性且 60 秒过期。
5. 终端的 cwd 只能是该 agent 的主 worktree 或它的任务 worktree。

## 已知缺口

- "Awaiting approval" 标签等不到输入：后端只写 `state` 为 `done` 与 `error` 的账本消息，`waiting` 分支事实上是死代码；真正的审批入口是 run 流的 `backend.oma.approval_request` 卡片。
- reducer 的 `member` action 没有分支，任何 `member` 派发都会被静默丢弃。
- notice 只能由 `role: "system"` 的账本消息产生，而当前没有这样的写入方。
- `apps/web/src/lib/revision-render.ts` 仍然导出 `isOpenMessageState`，全仓没有消费者。
- `optimisticSeq` 没有读写方：`send` 用的是 `crypto.randomUUID()` 生成的 `opt-<uuid>`。
- 发送后只有在 `triggeredRuns` 里 `queued === false` 的 run 才会被追踪；排队的输入要等轮询或下一次终态才有流。

## 相关页

- [端总览](./overview.md)
- [Conversation History](../conversation/history.md)
- [Run 输出与实时更新](../runs/output-and-live-updates.md)
- [Web 消息端到端](../flows/e2e-web-message.md)
- [排障指南](../operations/troubleshooting.md)
