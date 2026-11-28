# ADR 0083: Coding 工作台对标 Herdr — 双视角统一本体、多 Harness 终端与语义状态聚合

- 状态: Implemented（2026-11-28 完成全部三阶段实施与验证）
- 日期: 2026-11-28
- 相关: [设计哲学](../architecture/design-philosophy.md)、[ADR 0029](./0029-coding-agent-status-contract.md)（agent-status 文件契约）、[ADR 0039](./0039-approval-request-is-a-product-contract.md)（审批与 ACP 统一协议）、[ADR 0073](./0073-a-terminal-in-the-agents-own-workspace.md)（成员工作区终端）、[ADR 0077](./0077-requirement-owns-the-workspace.md)（需求拥有工作区）、[ADR 0082](./0082-cross-surface-linkage-human-labels-and-channels.md)（跨工作面关联与名称优先展示）

## 背景

CrewDesk 的 `/coding` 页面已经具备 Herdr（`herdr.dev`，“tmux for AI coding agents”）最底层的一块基建：后端进程托管可断连重连的 `bun-pty` 终端（`apps/backend/src/features/coding/terminal-registry.ts`）、基于单次票据的 `/ws/coding/:id` WebSocket 转发与 ring-buffer 回放、以及重启后的布局恢复（SQLite `coding_terminal` 表）。

但从产品形态与真机使用看，当前 `/coding` 仍停留在“通用终端列表 + 扁平 Worktree 列表”的雏形，与“**同一件事拥有「Conversation 视角」与「Coding 视角」**”的核心心智存在五个结构性缺口：

1. **双视角割裂，URL 上下文被主动擦除**：
   - `coding-page.tsx` 在聚焦终端时用 `window.history.replaceState(null, "", "/coding?t=...")` 覆盖地址栏，清掉了从会话或需求带入的 `?requirement=`、`?conversation=`、`?project=`；
   - 页面缺少顶栏的 `Conversation ↔ Coding` 一键切换，也没有把该工作区正在等待人类审批（HITL `pending_action`）的状态带入 Coding 视角。
2. **侧栏本体错位且存在状态点聚合 Bug**：
   - `coding-rail.tsx` 顶部堆了扁平的 `Terminals · all`，下方 `Worktrees` 直接把原始 ULID 前 12 位（`wt.requirementId.slice(0, 12)`）作为标题展示，违背 ADR 0082 名称优先原则；
   - `dotFor(terminals, project.projectId, defaultAgentId)` 按 `(projectId, agentId)` 聚合状态点，完全忽略 `workspaceId` 与 `cwd`，导致同一项目下所有需求工作树共享同一个错误状态点。
3. **ACP Worker 与交互式 PTY 互不可见（写冲突隐患）**：
   - 后台通过 ACP 派单执行的 Worker Run（`agent_run` 状态为 `running`/`waiting`）和人类在 `/coding` 打开的交互式 PTY 运行在同一个 ADR 0077 需求工作树（`workspace.path`）上；
   - 当前 `/coding` 看不到同一工作区上正在跑的 ACP Run，人打开 PTY 直接改代码或切分支时没有任何防撞提示。
4. **终端启动硬编码 `oma` 单一 CLI，且 respawn 丢失 `workspaceId`**：
   - `TerminalKind` 仅支持 `"shell" | "oma"`，面板只有单一 `oma` 启动按钮，无法按成员配置或用户选择在 PTY 中启动 CrewDesk 已注册的其他 harness（`claude`、`pi`、`omp`）；
   - `launch-oma` 与 `respawn` 调用 `resolveTarget(info.projectId, info.agentId)` 时漏传 `info.workspaceId`，在多需求工作树并存时会落回错误目录。
5. **非 `oma` Harness 缺少语义状态检测**：
   - 只有 `oma` 通过 `.oma/agent-status.json`（ADR 0029）上报 `working / blocked / idle`；在 PTY 中运行 `claude` / `pi` / `omp` 时侧栏与页头永远只显示泛化的 `running`，无法像 Herdr 一样一眼分辨哪个窗格在干活、哪个窗格卡在授权确认。

按[设计哲学](../architecture/design-philosophy.md)的**统一本体，不复制语义**与**边界要硬，概念要少**原则，本 ADR 定义将 `/coding` 升级为对标 Herdr 的双视角工作台的完整契约。

## 决策

### D1 双视角统一本体：`Requirement + Workspace` 是唯一核心实体，严禁 PTY 字节流回写账本

- **同一件事的两个投影面**：
  - **Conversation 视角**（`/chat/:cid`、`/requirements/:reqId`）：负责自然语言协作、派单、HITL 审批/追问与结构化产物（`conversation_ledger`、`agent_run`、`pending_action`、`artifact`）。
  - **Coding 视角**（`/coding`）：负责实时交互式 PTY 进程、多标签/分栏终端、工作树 Git 状态与 diff 查看。
- **硬边界**：PTY 字节流（xterm I/O）**绝不**写入或解析进 `conversation_ledger`。双视角通过共享的 `requirementId` / `workspaceId` / `conversationId` 关联，并互相投影实时运行态（Coding 展示 ACP Run 活跃态与待审批数；Conversation 侧栏展示关联的 PTY 终端）。

### D2 统一工作区读模型 `GET /api/coding/workspaces` 与 ACP/PTY 防撞感知

- 新增读接口 `GET /api/coding/workspaces`，以 ADR 0077 的打开中工作区（`workspace.status = 'open'`）为锚点，一次性聚合：
  - **人类可读标签**：`requirementId`、`requirementTitle`、`projectId`、`projectName`、最近关联的 `conversationId` / `conversationTitle`、`defaultAgentId`、`defaultHarness`；
  - **Git 状态**（best-effort 复用 `worktreeOps.status`）：`branch`、`path`、`ahead`、`behind`、`worktreeReady`；
  - **活跃 ACP Run**：匹配 `agent_run.status IN ('running', 'waiting')` 且 `workspace_root = workspace.path`（或同 `requirement_id`），携带 `runId`、`agentId`、`agentName`、`status`、`conversationId`、`pendingActionCount`；
  - **关联 PTY 终端**：匹配 `workspaceId` 或 `cwd === workspace.path` 的终端列表；
  - **统一聚合状态 `state`**，严格按优先级折算：
    `blocked`（任一 ACP Run `waiting` / `pendingActionCount > 0` 或任一 PTY `agentState === "blocked"`）
    > `working`（任一 ACP Run `running` 或任一 PTY `agentState === "working"`）
    > `running`（存在存活 shell PTY）
    > `idle`（存活 harness PTY 处于 `idle`）
    > `exited`（仅有已退出 PTY）
    > `empty`（尚无活跃 Run 与 PTY）。
- 同步在 `GET /api/coding/terminals` 每条终端 DTO 上附带同 `cwd` / `workspace` 的 `activeRuns`，使 ADR 0073 的成员独立工作区（`projectId = null`）同样具备 ACP Worker 防撞提醒。
- **不新增数据库表、不新增迁移**：全部由现有 `workspace`、`requirement_workspace`、`requirement`、`conversation`、`agent_run`、`pending_action` 与内存 `TerminalRegistry` 实时派生。

### D3 多 Harness PTY 启动与重启（零迁移）

- 将 `TerminalKind` 扩展为 `"shell" | "oma" | "claude" | "pi" | "omp"`（`CODING_HARNESSES = ["oma", "claude", "pi", "omp"]`）。SQLite `coding_terminal.kind` 为自由 `TEXT` 列，无需 schema 迁移；同步放宽 `adapter-sqlite.ts` 与 `persist.ts` 的 kind 校验。
- 新增 `POST /api/coding/terminals/:id/launch`，接受 `{ harness?: "oma" | "claude" | "pi" | "omp" }`：
  - 省略 `harness` 时使用该终端所属成员配置的 `runtime_config.harness`（默认 `"oma"`）；
  - 向运行中的 PTY 注入对应交互命令，更新 `kind = harness`、`title = harness` 并持久化；
  - 保留 `POST /api/coding/terminals/:id/launch-oma` 作为向后兼容薄别名（等价于 `{ harness: "oma" }`）。
- `POST /api/coding/terminals/:id/launch`、`launch-oma`、`respawn` 及启动恢复 `restoreCodingTerminals()` 统一传入 `info.workspaceId ?? undefined` 解析目标目录，并按 `kind` 选用对应的续跑命令（`oma --continue` / `claude --continue` / `pi --continue` / `omp --continue`，退出后 `exec bash`）。

### D4 跨 Harness PTY 语义状态检测（`pty-state.ts`）

- 维持 **ADR 0029 文件契约对 `oma` 的权威性**：`kind === "oma"` 时继续读取 `readAgentStatusFor(cwd)`（含过期校验，崩溃后不撒谎）；
- 对无状态文件的交互式 harness（`claude` / `pi` / `omp`），在 `TerminalRegistry` 记录每个 slot 的 `lastOutputAt` 并提供尾部快照（最近 4 KiB），由纯函数模块 `apps/backend/src/features/coding/pty-state.ts` 推导三态：
  1. 剥离 ANSI CSI/OSC 转义序列，检查尾部若干非空行；
  2. 若命中交互确认/权限审批提示模式（如 `(y/n)`、`[Y/n]`、`[y/N]`、`Allow once`、`Do you want to proceed`、`Yes, allow`、`Approve`、`Permission required`、`Waiting for approval`），立即判定为 **`blocked`**；
  3. 否则若距 `lastOutputAt` 小于活跃窗口（默认 `4000 ms`），判定为 **`working`**；
  4. 否则若已有输出且已静默，判定为 **`idle`**。
- 纯 shell 窗格（`kind === "shell"`）与已退出窗格（`status === "exited"`）不附带 `agentState`。

### D5 Web `/coding` 对标 Herdr 的工作区树与双视角工作栏

- **左侧栏重组为三层结构**：
  1. **Workspaces（需求工作区树）**：直接消费 `GET /api/coding/workspaces`，展示人类可读需求标题、`projectName · branch`、`↑ahead`、融合 ACP + PTY 的准确状态点与活跃 Worker 徽章；每个工作区下方直接嵌套属于该工作区的 PTY 窗格列表（点击聚焦，不新建；点击工作区行切入作用域并在无终端时新建带 `workspaceId` / `requirementId` / `conversationId` 的 shell）。
  2. **Agent Workspaces（ADR 0073）**：将 `projectId === null` 的成员独立工作区终端按成员分组嵌套展示。
  3. **Projects**：紧凑保留项目清单、创建项目弹窗（`ProjectForm`）与 `+ attach agent` 入口。
- **顶栏双视角切换与防撞条**：
  - 选中带需求/会话上下文的工作区或终端时，展示 **`Conversation` ↔ `Coding`** 切换栏、分支与 `↑ahead` 信息、只读 **Git Diff** 抽屉弹窗（复用现有 `GET /api/projects/:id/worktrees/:workspaceId/diff`），以及 `blocked` 时的 **Review approval** 一键跳转；
  - 当前工作区/目录存在活跃 ACP Run 时，在终端上方显式展示防撞横幅（区分 `waiting` 待审批与 `running` 执行中），并提供一键跳转对应会话的入口；
  - 修复 `replaceState` 擦除 URL 参数问题：切换聚焦窗格时保留 `requirement`、`conversation`、`project` 与 `t` 查询参数；
  - 窗格顶栏提供多 Harness 启动器（一键启动默认 harness + 下拉选择 `oma / claude / pi / omp`），状态文案显示真实 harness 名称而非硬编码 `oma`。

### D6 打开 `/coding` 默认自动恢复上次 Coding Agent 状态（非破坏性 Resume）

- **前端自动聚焦恢复（`pickResumeTerminal`）**：直接进入 `/coding`（无 `?locate=1` 显式缺失）或刷新 `/coding?t=<id>` 时，不再落回空白占位页，而是按固定优先级自动恢复并附着已有运行中终端（`localStorage` 仅记住最后聚焦的 `terminalId` / `workspaceId`，绝不自动新建进程）：
  1. URL `?t=<terminalId>` 命中的终端；
  2. `localStorage["coding-last-terminal"]` 仍存活的终端；
  3. `localStorage["coding-last-workspace"]` 中注意力优先级最高的终端；
  4. 全局注意力优先级最高的终端（`blocked > working > running harness > running shell > exited`，同级按最新启动时间）。
- **后端开机恢复**：后端启动时通过 `restoreCodingTerminals()`（`wiring-lifecycle.ts`）读取 SQLite `coding_terminal`，按原 `workspaceId` 与 `kind` 以 `<cli> --continue; exec bash` 恢复会话进程；前端打开后即自动附着回放 scrollback。

### D7 Coding Agent 执行完成与阻塞审批通知（全局生效）

- **纯状态跃迁检测（`notifications.ts`）**：首次拉取只建立基线，绝不在页面加载/刷新时刷屏；后续轮询检测到以下跃迁时触发通知：
  - **执行完成（`completed`）**：交互式 PTY 从 `working → idle`、非 shell harness 窗格从 `running → exited`，或工作区活跃 ACP Worker Run 全部结束；
  - **需要人工确认（`blocked`）**：交互式 PTY 进入 `blocked` 提示，或工作区 ACP Run 新增待审批 `pending_action`。
- **双通道提醒 + 全局感知**：
  - 挂载于 `AppShell` 的 `<CodingNotifier />` 在全站任意页面（`/chat`、`/today` 等）均可弹出带一键跳转按钮的站内 Toast；
  - 当浏览器标签页处于后台（`document.visibilityState === "hidden"`）且已授予浏览器通知权限时，同步发送原生桌面通知（`Notification` API），点击即拉回窗口并跳转对应终端/审批会话；
  - `/coding` 工具栏提供通知开关与桌面通知授权按钮（`localStorage["coding-notify-pref"]` 持久化静音状态），`NavRail` 的 `Coding` 入口同步显示 `blocked` 计数徽标或 `working` 脉冲点。

## 拒绝的方案

1. **在 Coding 页内嵌第二套聊天输入框**：违反“统一本体，不复制语义”；双视角通过一键切换共享同一会话页，而不是在 `/coding` 维护一份缩水版 `ConversationPanel`。
2. **引入独立 `tmux` 外部守护进程**：当前 `bun-pty` + SQLite 布局恢复已经满足单机断连不杀进程与跨重启恢复，引入外部 `tmux` 增加部署依赖与状态双写，暂不值得（仅在未来需要后端热重启期间不断开 PTY 进程时再单独评估）。
3. **把 PTY 输出反向写入 `conversation_ledger`**：交互终端的终端控制符、探索性试错和中间命令噪音极大，会污染会话上下文与压缩摘要。

## 验证清单

- 后端单测覆盖：`pty-state.test.ts`（ANSI 剥离、`blocked/working/idle` 判定）、`terminal-registry.test.ts`（`lastOutputAt` 与 `getActivity`）、`adapter-sqlite.test.ts`（多 harness `kind` 读写往返）、`http.test.ts`（`GET /api/coding/workspaces` 状态聚合与防撞、`POST /api/coding/terminals/:id/launch` 多 harness 与 `workspaceId` 透传）。
- 前端单测与静态门禁：`locate.test.ts`（URL 构造与保留、工作区筛选辅助）、`apps/web/src/lib/locales/pages/index.test.ts`（零词典冲突）、`bun run --cwd apps/backend build && bun run --cwd apps/backend typecheck && bun run --cwd apps/web typecheck`、`bun run audit`（contracts / workspace / docs / ui 全绿）。
