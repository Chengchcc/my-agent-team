---
id: surfaces.web
title: Web 端
status: current
owners: architecture
last_verified_against_code: 2026-09-22
summary: "Web 端是浏览器里的对话界面 + worktree 终端页（/coding）。对话页消费 conversation SSE，在 conversation-reducer 里按 messageId upsert。消费 conversation SSE，在 conversation-reducer 里按 messageId upsert 到 items[]。items 是 UiItem 联合（message / notice）。busy 从 open message 的 state 推导。"
depends_on:
  - conversation.history
  - runs.output-and-live-updates
used_by:
  - flows.e2e-web-message
  - operations.troubleshooting
---

# Web 端
> ⚠ **部分过时（2026-08-13）**：roster 多成员 UI 已按 ADR 0021 收编为单 Agent；对话页单 agent 视角，新增 agent 详情 Workspace tab（只读文件浏览）。

Web 端是浏览器里的对话界面。它开启一个 SSE 连接到 `/api/bff/conversations/:id/events`，接收 [ledger](../conversation/history.md) 推送的条目。reducer 按 `messageId` upsert 到 `items[]`（`UiItem` 联合：`message` 和 `notice` 两种 kind）。busy 从 open message 的 `state` 字段推导——state 为 `streaming` 或 `waiting` 时表示 Agent 仍在运行或等待审批。

## ConvState

```ts
{
  viewerMemberId: string,
  roster: Record<string, SenderRef>,        // SenderRef.kind: "agent" | "human"
  items: UiItem[],                          // { kind: "message"; id; sender; content: Message }
                                            // | { kind: "notice"; id; text: string }
  streamConn: "connecting" | "open" | "reconnecting" | "closed",
  error: string | null,
  optimisticSeq: number,
  triggerMode: "auto" | "mention",
  todos: Array<{ step, status: "pending" | "in_progress" | "done" }>,
  pendingSendCount: number
}
```

Actions：`bootstrap`、`member`、`message`、`send`、`conn`、`toggleTriggerMode`、`send/error`、`todo/update`。

## SSE 事件类型

- `message` → `parseRevision(seq, content)` 解出 `ConversationMessageRevision`，按 `messageId` upsert
- `member.joined` / `member.left` → `member` action，`kind: "notice"` 的 UiItem
- `todo` → `todo/update` action

连接没有 idle timeout。后端每 ~15s 发 SSE comment `: ping\n\n` keepalive。terminal 状态不靠 `event: done`，靠 message revision 的 `state: "done"` / `state: "error"`。

## busy 推导

```ts
export function isBusy(s: ConvState): boolean {
  if (s.pendingSendCount > 0) return true;
  return s.items.some(
    (item) =>
      item.kind === "message" &&
      item.sender.kind === "agent" &&
      item.content.state != null &&
      isOpenMessageState(item.content.state),
  );
}
```

`ConversationCanvas` 用 `busy` 控制动画点、状态标签（"Running" / "Awaiting Approval"）。

## 关键纯函数

- `upsertAuthoritative`：同 messageId 就替换；否则对自己消息替换最近乐观消息（`opt-` 前缀）；再否则追加。
- `isConclusionMessage`：有非空 text 且无 tool_use block 即为 conclusion。
- `groupTurns`：连续同 Agent 消息收成一个 `turn`，`conclusion` 取最后一条 conclusion，其余进 `rounds`。

## Timeline 锚点

锚点放在 human 发言边界上。Agent turn 经 `ReasoningTrace` 渲染，不带锚点。notice 段独立渲染，不参与 turn 分组。纯 Agent→Agent 链以 sender-change 边界兜底。

## Coding 页（worktree 终端）

`/coding` 是 project/worktree 的**终端宿主**（对标 Herdr），与对话页彻底分离：对话页走 Agent Run（adapter spawn `oma --mode rpc`，产物进 ledger），Coding 页走**裸 PTY**，进程归 backend 进程所有。

```text
侧边栏 Coding → /coding
  左栏两半：Projects(汇总点+分支) / worktrees 拍平(状态点，点击直达 pane)
  右栏：per-worktree 终端 tab(+ 新终端 / ◫ split 并排) → xterm.js
```

**数据链路与鉴权**：REST 走既有 BFF 链（cookie → `x-auth-token`）；**终端字节流绕开 BFF 直连 backend**（Next 的 route handler 代理不了 WebSocket），鉴权用**一次性 ticket**（256bit / 60s / 单次，经认证链铸造）——`app.ts` 的全局 authGuard 只豁免 `/ws/*`，票在 ws 路由内校验。浏览器 WebSocket 无法设自定义 header，这是该设计的唯一原因。

**终端生命周期（tmux 语义，方案 A：不垫 tmux 二进制）**：PTY 挂在 backend 进程（`features/coding/terminal-registry.ts`，bun-pty）。**detach（关页面/断线）永不杀进程**；close 是显式 kill-pane（活进程需确认）；进程死后留遗容（冻结屏幕 + ring buffer 400k 字符）可 respawn；backend 重启 = PTY 全灭，靠持久化的成员快照 `restore`（oma 面板以 `oma --continue; exec bash` 形态复活，会话上下文在磁盘 session 文件里）。

**pane 默认是 shell**（Herdr 对齐）：oma 不是 spawn 参数，而是「oma」按钮注入已解析命令（dev = `bun cli.ts`，prod = `OMA_BIN`）。该 oma **无 Run Token**，product tools 不可用——已知取舍。

**状态点**：oma TUI 写 `<worktree>/.oma/agent-status.json`（working/blocked/idle，运行中 60s 心跳），backend 对活的 oma 面板聚合 `agentState`（>3 分钟无心跳视为 unknown，不谎报），web 渲染四态点。**不读屏**——与 Herdr 的根本分歧。

**worktree 双轴**（ADR 0023 + 附录）：主 worktree 是 (agent × project) 的 attach 产物（reconcile 按需物化）；**任务 worktree**（`<projectId>.<slug>`）是显式创建的并行 checkout，有独立删除入口（脏区/未合并提交需显式 force）。终端的 `worktreePath` 必须过 agent 命名空间前缀白名单——终端即代码执行，cwd 永不接受任意路径。

## 失败模式

- 乐观消息残留：ledger echo 丢失时 `opt-` 消息不会被替换；messageId 不匹配时持久消息重复显示。
- streaming 文本不刷新：revision messageId 和前序不一致导致独立消息。
- 缺 reasoning：`reasoning_delta` 端到端产生，适配器从 thinking block 发出。不需要就在上游去掉。
- 轮询抖动：不稳定 effect 依赖重建 interval。

## 关联页面

- [Project 与 Worktree](../agents/projects-and-worktrees.md)
- [ADR 0023 Project 多对多工作区](../../adr/0023-project-worktree-workspace.md)
- [对话账本](../conversation/history.md)
- [会话投影](../runs/output-and-live-updates.md)
- [Web 消息端到端](../flows/e2e-web-message.md)
- [排障手册](../operations/troubleshooting.md)
