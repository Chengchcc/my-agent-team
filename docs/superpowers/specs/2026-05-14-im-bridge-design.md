# my-agent IM 桥接层 — 架构设计

## 概述

在 my-agent 现有 agent 框架上增加飞书 IM 桥接层，实现：飞书话题群发消息 → bot 自动启动 agent 实例处理 → 流式卡片实时展示输出 → 持续多轮对话。

**不做 SDK wrapper，my-agent 自己当 agent。**

---

## 1. 进程模型

```
一个 bot = 一个 daemon 进程（BOTMUX_BOT_INDEX）
  └── 单进程内管理多个 Agent 实例（per-session-key）
  └── 共享 Provider / ToolRegistry / Skills loader
  └── 独立 ContextManager / MemoryStore （per Agent 实例）

bots.json:
  [{ larkAppId, larkAppSecret, profileId, allowedUsers }]

现有 headless / TUI 模式不变。不加 --daemon 参数就是现在的单 agent 模式。
```

### 进程保活

```
systemd user unit (Linux):
  ~/.config/systemd/user/my-agent-bot@.service
  → systemctl --user enable my-agent-bot@backend
  → Restart=on-failure, RestartSec=5s

launchd (macOS):
  ~/Library/LaunchAgents/com.my-agent.bot.plist
  → KeepAlive=true

autostart enable/disable 子命令管理注册。
```

---

## 2. Profile 系统

### 两层分离

**Layer 1: Identity Workspace** — Markdown 文件，注入 system prompt

```
~/.my-agent/profiles/<id>/
  AGENTS.md      → 行为规则（复用现有 AGENTS.md 注入机制）
  SOUL.md        → 人格、语气、价值观
  IDENTITY.md    → 名字、角色、emoji
  memory.db       → 独立记忆存储
  sessions/       → 独立会话持久化
```

**Layer 2: Runtime Config** — YAML，daemon 执行时强制

```yaml
# ~/.my-agent/bots.yml
profiles:
  backend-expert:
    workspace: ~/.my-agent/profiles/backend-expert
    model: claude-opus-4-7           # 可选，覆盖全局
    toolProfile: code_editor          # 复用 SubAgentProfile
    workingDir: ~/projects/api
    allowedRoots: [~/projects/api]
    permissionTimeoutMs: 60000        # IM 模式超时

bots:
  - larkAppId: cli_xxx
    larkAppSecret: xxx
    profileId: backend-expert
    allowedUsers: [alice@example.com]
```

### 工具权限（复用并提升 SubAgentProfile）

```typescript
// 现有 sub-agent-config.ts 的 PROFILE_TOOLS 直接复用
const PROFILE_TOOLS = {
  read_only:   ['read', 'grep', 'glob', 'ls'],
  code_editor: ['read', 'grep', 'glob', 'ls', 'text_editor', 'bash'],
  general:     [],  // all tools except ALWAYS_EXCLUDE
};

// 提升到 Agent 级别：bot profile.toolProfile 决定 agent 实例的工具白名单
```

### Profile 变更 vs 运行中 Agent

- Profile 文件更新只影响新建 session
- 已有 session 继续用旧 profile
- 需要变更时手动 `/restart` 重建 agent 实例

---

## 3. 路由模型

```typescript
// 路由 key = sessionKey(anchor, larkAppId)
// 飞书消息路由完全模仿 botmux 的 scope 模型

interface RoutingContext {
  chatId: string;
  messageId: string;
  chatType: 'group' | 'p2p';
  scope: 'thread' | 'chat';
  anchor: string;    // chatId (chat-scope) 或 rootMessageId (thread-scope)
  larkAppId: string;
}
```

| 群类型 | scope | anchor | Agent 生命周期 |
|--------|-------|--------|---------------|
| 普通群 | chat | chatId | 整个群一个 Agent 实例 |
| 话题群 | thread | rootMessageId | 每个话题一个 Agent 实例 |
| P2P | thread | messageId | 每条顶层消息新话题 |

### 路由决策（和 botmux 一致）

```
root_id + thread_id 同时存在 → thread-scope (anchor=root_id，真话题)
只有 root_id 没有 thread_id → 引用气泡，不是真话题（飞书已知 bug）
话题群 chat_mode       → 新消息 = thread-scope (anchor=message_id，种子话题)
普通群 chat_mode       → chat-scope (anchor=chatId)
/t 或 /topic 前缀      → 强制 thread-scope，无视 chat_mode
```

---

## 4. Agent 实例隔离

```typescript
// createAgentRuntime() 的重用和隔离

共享（进程内单例）:
  Provider          — 单 LLM 长连接，rate limiter 全局协调
  ToolRegistry      — 工具定义只读，per-agent 执行时白名单过滤
  Skills loader     — 元数据只读，各 agent system prompt 一致注入

隔离（per Agent 实例）:
  ContextManager    — 独立对话历史、token budget、compaction 状态
  MemoryStore       — profile 目录下的独立 memory.db
  SessionStore      — profile 目录下的独立 session JSONL
  Tool 白名单       — PROFILE_TOOLS[profile.toolProfile] 过滤
```

---

## 5. 飞书卡片渲染

### 流式卡片

```
AgentEvent.text_delta → 累积 Markdown → debounce 200ms → PATCH 卡片 lark_md 元素
AgentEvent.tool_call_start → 可选插入 "🔧 调用 xxx..." 标记
AgentEvent.tool_call_result → 追加结果摘要（超过 3000 字截断 + "...在终端查看完整输出"）
AgentEvent.turn_complete → freeze 卡片（状态变绿 "等待输入"）
下一条用户消息 → 新卡片，旧卡片 frozenCards 中存档
```

### 不需要 screenshot

botmux 需要 screenshot 因为 PTY 输出是 ANSI 转义序列。my-agent 的结构化 AgentEvent 直接出 Markdown，直接用飞书 lark_md 元素。不需要 canvas、PNG、上传。

### 卡片 PATCH 并发控制

```
cardPatchInFlight: boolean     // 同一时间只允许一个 PATCH
pendingCardJson: string | null // 飞行中到达的新更新替换 pending（latest wins）
```

### 卡片按钮

```
[📖 显示/隐藏输出] [🖥️ 打开终端] [🔄 重启] [❌ 关闭会话]
```

### 大输出处理

飞书卡片 body 约 30KB 限制。单轮 tool output 超过 3000 字时截断，追加 "(已截断，在终端查看完整输出)" 链接。

---

## 6. 交互式适配（Permission + AskUserQuestion）

### 架构

现有 PermissionManager 和 AskUserQuestionManager 使用 subscribe + resolve Promise 模式。IM 模式下，daemon 替换 React hook 成为订阅者：

```
TUI 模式: Agent → globalManager.askUserQuestion() → Promise pending
            → React hook subscribe → 渲染 modal
            → 用户点击 → respondWithAnswers() → Promise resolve

IM 模式:  Agent → globalManager.askUserQuestion() → Promise pending
            → daemon subscribe → 构建飞书卡片（选项按钮）
            → 发送到飞书话题
            → 用户点按钮 → card callback → respondWithAnswers()
            → PATCH 卡片为 "已回答" → Promise resolve
```

### Permission 卡片

```
┌──────────────────────────────────┐
│ 🟡 危险命令确认                   │
├──────────────────────────────────┤
│ Command: "rm -rf dist && npm..." │
│ ⚠️ destructive file deletion     │
├──────────────────────────────────┤
│ [✅ 允许] [❌ 拒绝] [🔓 始终允许]  │
└──────────────────────────────────┘
```

### AskUserQuestion 卡片

```
┌──────────────────────────────────┐
│ 🔵 认证方式选择                   │
├──────────────────────────────────┤
│ 1. JWT (无状态，适合微服务)       │
│ 2. Session Cookie (传统方案)      │
├──────────────────────────────────┤
│ [✅ 选项1]  [选项2]               │
└──────────────────────────────────┘
```

### 超时处理

| 类型 | TUI 超时 | IM 超时 | 超时行为 |
|------|---------|---------|---------|
| Permission | 10s | 60s (per-profile 可配) | auto-deny + PATCH 卡片 "⏰ 已超时自动拒绝" |
| AskUserQuestion | 无超时 | 无超时（可选加） | 卡片持续有效直到回答 |

---

## 7. 任务连续性

### 消息队列

```
用户消息到达
  → agent busy？→ enqueue
  → agent idle？→ 直接投递，标记 busy
AgentEvent.turn_complete
  → 标记 idle → dequeue next
```

### 增量持久化

```
每次 AgentEvent 产生 → append 到 session JSONL（一行一个 event）
daemon 重启 → replay JSONL → 重建 ContextManager
最后一个 event 是 tool_call_start 且无 tool_call_result → 重跑该 tool
```

### 飞书重连

```
WS 断连 → SDK 自动重连
重连后主动拉取未读消息（im/v1/messages list API 按时间倒序）
和已处理 messageId 对比 → 补处理漏掉的消息
```

### 优雅关闭

```
SIGTERM →
  1. 标记 daemon 为 draining（不接受新消息）
  2. 等待当前 turn 完成（最多 30s）
  3. flush session JSONL
  4. 退出
SIGKILL → 无优雅，靠增量持久化恢复
```

---

## 8. 新增源代码结构

```
src/
  im/                          # IM 桥接层（新增）
    lark/
      event-dispatcher.ts      # WS 长连接 + 消息路由
      card-builder.ts          # 飞书卡片构建（lark_md 元素）
      card-handler.ts          # 卡片交互（permission/ask/command）
      client.ts                # Lark API 封装（send/reply/patch/upload）
      message-parser.ts        # 消息内容解析（text/post/merge_forward）
    types.ts                   # BotConfig, AgentProfile, RoutingContext
  daemon/
    daemon.ts                  # 单 bot 常驻进程入口
    session-manager.ts         # Agent 实例池 + 生命周期 + 消息队列
    command-handler.ts         # 斜杠命令（/repo, /restart, /close, /t 等）
    scheduler.ts               # 定时任务
    interactive-bridge.ts      # Permission/AskUserQuestion → IM 卡片适配
  profile/
    loader.ts                  # Profile 加载 + 校验 + workspace 文件注入
    types.ts
  bin/
    my-agent-daemon.ts         # daemon 启动入口

修改现有文件:
  src/agent/sub-agent-config.ts  # PROFILE_TOOLS 提升为 agent 级可复用
  src/runtime.ts                  # createAgentRuntime() 支持 per-profile 参数覆盖
  src/cli/tui/                    # 新增 /daemon 命令 + daemon session 浏览
```

---

## 9. TUI 会话浏览（/daemon 命令）

```
TUI 中输入 /daemon
  → 列出运行中 daemon（扫描 PID 文件 / dashboard registry）
  → 选择 daemon → 列出活跃 session
  → 选择 session → load session context → TUI 开始交互
不加 /daemon → 现在的单 agent 模式不变
```

---

## 10. Bot 配置流程

### 首次配置（交互式）

```bash
# Step 1: 创建 profile 工作区
my-agent profile create backend-expert
# → 交互式问答：角色、工作目录、工具权限
# → 生成 ~/.my-agent/profiles/backend-expert/{AGENTS.md,SOUL.md,IDENTITY.md}

# Step 2: 注册飞书 bot
my-agent bot add
# → 输入 Lark App ID / App Secret
# → 选择 profile（backend-expert）
# → 设置 allowedUsers
# → 写入 ~/.my-agent/bots.yml

# Step 3: 启动 daemon
my-agent daemon start backend-expert
# → systemd user unit 注册 + 启动
# → 飞书长连接建立

# Step 4: 飞书开放平台配置
# → 事件订阅：长连接模式
# → 添加事件：im.message.receive_v1
# → 启用卡片回调：card.action.trigger
# → 发版（仅自己可见，免审核）

# Step 5: 建群验证
# → 飞书创建话题群 → 添加机器人 → 发消息 → 确认响应
```

### 日常管理

```bash
my-agent daemon list              # 列出运行中 daemon，显示 session 数
my-agent daemon logs backend      # 查看指定 daemon 日志
my-agent daemon restart backend   # 重启 daemon（tmux session 保留）
my-agent daemon stop backend      # 停止 daemon

my-agent bot edit backend         # 修改 bot 配置（allowedUsers 等）
my-agent bot remove backend       # 删除 bot 配置

my-agent profile edit backend-expert  # 编辑 profile（SOUL.md 等）
my-agent profile list                 # 列出所有 profile

my-agent autostart enable         # 开机自启
my-agent autostart disable        # 取消开机自启
```

### Profile 模板（profile create 的交互流）

```
> my-agent profile create backend-expert

? 角色描述: 后端架构师，负责 API 设计、数据库优化、部署运维
? 工作目录: ~/projects/api
? 工具权限:
  [ ] read_only (只读：read, grep, glob, ls)
  [x] code_editor (读写：+ text_editor, bash)
  [ ] general (全部工具)
? 模型 (回车使用全局默认 claude-opus-4-7):
? allowedRoots (逗号分隔，默认等于工作目录):

✅ Profile "backend-expert" 已创建
   workspace: ~/.my-agent/profiles/backend-expert/
   编辑 SOUL.md 和 IDENTITY.md 可定制人格
```

---

## 11. 验收标准

### D1: Profile 系统

| # | 验收项 | 验证方式 |
|---|--------|---------|
| P1 | `profile create` 创建 workspace 目录 + AGENTS.md/SOUL.md/IDENTITY.md | 文件存在，内容正确 |
| P2 | `bots.yml` 中 bot 绑定 profile，daemon 启动时加载正确的 profile | 日志输出 profile 名称 |
| P3 | 不同 profile 的 Agent 实例使用独立的 memory.db | 给 bot A 发送 "记住我是张三"，bot B 问 "我是谁"——bot B 不知道 |
| P4 | per-profile toolProfile 过滤生效 | `read_only` profile 的 bot 被要求跑 bash → agent_error |
| P5 | per-profile model 覆盖生效 | 设置 `model: claude-haiku`，daemon 日志显示使用的 model |

### D2: Daemon 进程 + 保活

| # | 验收项 | 验证方式 |
|---|--------|---------|
| D1 | `my-agent daemon start <profile>` 启动单 bot daemon | `ps aux` 显示进程，飞书 WS 连接建立 |
| D2 | `my-agent daemon stop <profile>` 优雅关闭 | SIGTERM → drain → flush → exit |
| D3 | 进程异常退出后 systemd 自动拉起 | `kill -9 <pid>` → 5s 内新进程出现 |
| D4 | 多 daemon 互不干扰 | 启动两个 daemon，各自独立工作 |
| D5 | `my-agent autostart enable` 注册开机自启 | 重启机器后 daemon 自动运行 |

### D3: 飞书消息路由

| # | 验收项 | 验证方式 |
|---|--------|---------|
| R1 | 话题群新消息 → 创建 Agent 实例 + 流式卡片 | 发消息，卡片出现并实时更新 |
| R2 | 话题群同话题 follow-up → 同一 Agent 实例继续 | 同一个卡片被 PATCH 更新，context 延续 |
| R3 | 话题群不同话题 → 独立 Agent 实例 | 两个话题各自独立卡片和 context |
| R4 | 普通群消息 → chat-scope，全群一个 Agent 实例 | 多条消息在同一 session 中 |
| R5 | 普通群中发 `/t prompt` → 强制开新话题 | 新 thread，独立卡片 |
| R6 | P2P 私聊 → 正常响应 | Agent 正常工作 |
| R7 | @mention 检测正确——单 bot 群不 @ 也响应；未被 @ 不响应 | 多 bot 群只响应 @自己的消息 |
| R8 | 路由决策正确区分引用气泡 vs 真话题（root_id without thread_id） | 引用回复不产生新话题 |

### D4: 流式卡片

| # | 验收项 | 验证方式 |
|---|--------|---------|
| C1 | text_delta → 卡片 lark_md 内容实时更新 | 发 "写一个 hello world"，代码逐渐出现在卡片上 |
| C2 | tool_call → 卡片显示工具调用状态 | 看到 "🔧 调用 bash..." 标记 |
| C3 | turn_complete → 卡片 freeze，状态变绿 "等待输入" | 上一轮卡片停止更新 |
| C4 | 下一轮用户消息 → 新卡片 | 新的流式卡片出现 |
| C5 | 大输出截断 + 提示 | 超过 3000 字的 tool output 被截断 |
| C6 | PATCH 并发控制：同时只一个 PATCH in-flight | 无竞态导致的卡片状态错乱 |
| C7 | 卡片按钮功能正常 | 显示/隐藏、重启、关闭按钮正常工作 |

### D5: 交互适配

| # | 验收项 | 验证方式 |
|---|--------|---------|
| I1 | 危险命令触发飞书 permission 卡片 | 发 "rm -rf node_modules"，bot 弹出确认卡片 |
| I2 | 用户点击 "允许" → 命令执行 | permission resolve → bash 执行 |
| I3 | 用户点击 "拒绝" → 命令被阻止 | permission reject → agent 收到错误 |
| I4 | IM 模式超时（默认 60s）→ auto-deny + 卡片更新 | 60s 不点 → 卡片显示 "已超时自动拒绝" |
| I5 | ask_user_question 触发飞书选项卡片 | 选项正确渲染为按钮 |
| I6 | 用户选择选项 → Promise resolve | agent 收到用户选择，继续执行 |
| I7 | multiSelect 类型正确渲染为 toggle 按钮 | 多选卡片可切换 |

### D6: 任务连续性

| # | 验收项 | 验证方式 |
|---|--------|---------|
| T1 | Agent 忙时新消息进入队列，turn_complete 后出队 | 连续发两条消息，第二条在第一轮完成后处理 |
| T2 | Daemon 正常重启 → session 恢复 | `daemon restart` → replay JSONL → context 延续 |
| T3 | Daemon crash → 增量持久化恢复 context | `kill -9` → systemd 拉起 → context 不丢 |
| T4 | 飞书 WS 断连重连 → 补拉未读消息 | 断网 30s → 恢复 → 消息不丢 |

### D7: TUI /daemon 命令

| # | 验收项 | 验证方式 |
|---|--------|---------|
| U1 | `/daemon` 列出运行中 daemon | 显示进程名、session 数量、运行时间 |
| U2 | 选择 daemon → 列出活跃 session | 显示 chatId/topic、scope、状态 |
| U3 | 选择 session → load 到 TUI | context 恢复，可以继续对话 |
| U4 | 不选 daemon → 现有单 agent 模式正常 | 无回归 |

### D8: CLI 命令

| # | 验收项 | 验证方式 |
|---|--------|---------|
| L1 | 会话内 agent 可调用 `botmux send` 等价命令 | agent 在飞书话题中回复消息 |
| L2 | 斜杠命令（/repo, /restart, /close, /status）正常工作 | 输入命令 → 预期行为 |
| L3 | `/close` 后 session persist，可以被 TUI `/daemon` 恢复 | session JSONL 文件存在且可 replay |

### D9: 架构合规

| # | 验收项 | 验证方式 |
|---|--------|---------|
| A1 | `bin/my-agent-daemon.ts` 不直接实例化 Agent/ToolRegistry | 全部走 `createAgentRuntime()` |
| A2 | 无新增 `any` 类型或 unsafe cast | `bun run check:arch` 通过 |
| A3 | 新增模块有单元测试 | `bun test` 覆盖新增文件 |
| A4 | 文件不超过 400 行，函数不超过 80 行 | `bun run check:arch` 通过 |

### 端到端验收：Golden Path

```
1. my-agent profile create test-bot
   → 交互式问答完成 profile 创建

2. my-agent bot add
   → 输入 Lark 凭证完成 bot 注册

3. my-agent daemon start test-bot
   → daemon 启动，飞书 WS 连接建立

4. 飞书话题群中发 "你好，请记住我的名字是张三"
   → 🟡 卡片出现 "启动中…"
   → 🔵 卡片实时更新 agent 输出
   → 🟢 卡片 freeze "等待输入"

5. 同一话题中发 "我叫什么名字？"
   → 同一卡片 PATCH 更新
   → agent 回答 "张三"
   → 验证 memory 隔离有效

6. 同一话题中发 "rm -rf /tmp/test"
   → 🟡 卡片弹出 "危险命令确认"
   → 点 "允许" → 命令执行
   → 验证 permission 卡片正常

7. 另一话题发 "'写一个冒泡排序"
   → 新卡片出现，独立 context
   → 和第一个话题互不影响

8. my-agent daemon stop test-bot
   → daemon 优雅退出，session persist

9. my-agent daemon start test-bot
   → daemon 重连，session 自动恢复

10. TUI 中 /daemon → 选择 test-bot → 选择 session → 继续对话
    → 验证 TUI↔IM 会话互通
```

---

## 12. 不做的事

- Web 终端（xterm.js）— 不做
- 多 IM 渠道（Slack/Discord 等）— 只做飞书
- Sandbox (Docker/SSH) — allowedRoots + workingDir 够用
- Bot-to-bot 协作 — 单 bot 不需要
- Screenshot 卡片 — 用 Markdown 替代
- Gateway / Channel 抽象层 — daemon 直接对接 Lark API
