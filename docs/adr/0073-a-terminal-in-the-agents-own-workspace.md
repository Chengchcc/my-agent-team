# ADR 0073: 从会话直接打开工人所在的工作区终端

- 状态: Accepted
- 日期: 2026-11-20
- 相关: ADR 0019/0020（agent workspace）、ADR 0023（project worktree）、ADR 0070（派发即子会话）

## 背景

worker 就是"在一个目录里跑 oma"。Web 的 coding 模块能开出**同一个目录**的终端，但它只认 project 轴：

```
POST /api/coding/terminals { projectId(必填), agentId(必填), worktreePath? }
resolveCodingTarget: agent 必须已 attach 该 project → cwd = <agentWs>/projects/<projectId>
```

于是"从会话跳到这个 agent 正在干活的目录"没有入口：大多数会话没有 `projectId`，而 operator 想看的恰恰是**agent 自己的工作区**（`<dataDir>/agents/<slug>`），不是某个项目 worktree。

## 决策

### D1 终端目标可以是"agent 自己的 workspace"

`projectId` 在终端模型里变为**可空**（`string | null`）：

- `null` ⇒ cwd = `agent.workspacePath`（无 worktree、无 mirror）；
- 有值 ⇒ 维持 ADR 0023 的 project worktree 语义（含 task worktree）。

一条分支在 `resolveCodingTarget` 里，`shell`/`omaLaunch`/`omaPane` 由同一个 `targetOf(cwd)` 构造，避免两套命令拼装逻辑漂移。

### D2 会话 header 的入口

会话页 header 增加 **Terminal**：指向 `/coding?agent=<conversation.agentId>`。

- 前台房间 ⇒ 前台的工作区；
- 子会话（工人房间，ADR 0070）⇒ **工人的**工作区——这就是"下车间看它到底在干什么"的正确落点，且不用先建项目。

### D3 侧边栏按"有没有项目"分组

coding 侧边栏新增 **Workspace** 区（`projectId === null` 的终端，按 agent 一行）；`CodingSelection.projectId` 变为可选，`undefined` 表示工作区面板。

### D4 深链要"点了有事发生"

`?agent=` 打开时：选中该 agent 的工作区面板；若还没有面板，则**直接起一个**。这不是"跳到空白页让用户再点一次"。

## 不变量

1. 一个终端要么属于某个 (agent, project) worktree，要么属于 agent 自己的工作区，二者互斥。
2. 工作区终端的 cwd 永远是该 agent 的 `workspacePath`，不读取、不写入别的 agent 的目录（与 ADR 0072 的写入围栏一致）。
3. 项目轴的行为不变：attach 校验、task worktree、mirror materialize 全部照旧。

## 落点

| 层 | 文件 |
|---|---|
| 终端模型 | `features/coding/terminal-registry.ts`（`projectId: string \| null`）、`persist.ts`（允许 null） |
| 路由 | `features/coding/http.ts`（`projectId` 可选、`resolveTarget` 放宽） |
| 目标解析 | `bootstrap/features.ts`（`targetOf(cwd)` + 工作区分支） |
| Web | `features/coding/components/{coding-page,coding-rail}.tsx`、`components/ConversationCanvas.tsx`（Terminal 入口） |

## 验收

1. ✓ 不带 `projectId` 的 POST 返回 201，且 `terminal.projectId === null`（路由测试）。
2. ✓ 带 `projectId` 的行为不变（既有 apply/attach/task-worktree 测试全绿）。
3. 待真机：会话 header 点 Terminal → 落在 `/coding?agent=<id>` → 自动开面板 → cwd 是该 agent 的 workspace。
