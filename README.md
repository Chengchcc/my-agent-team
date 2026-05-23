# my-agent

<p align="center">
  <strong>AI 编程 Agent — 终端 TUI + 飞书桥接，一条消息启动编程会话</strong>
</p>

<p align="center">
  中文 | <a href="README.en.md">English</a>
</p>

---

**两种使用方式，同一套 Agent 内核：**

| 模式 | 入口 | 场景 |
|------|------|------|
| 🖥️ **终端 TUI** | `bun tui` | 本地开发，流式输出，语法高亮 |
| 📱 **飞书 Bot** | `bun daemon <agent>` | 话题群发消息 → Agent 自动响应，流式卡片 |

---

## 为什么选择 my-agent

- **结构化事件流**：`DataPlaneEvent` 在内核与前端之间走单一总线，飞书卡片直接用 Markdown 渲染，不需要截图管道。
- **内置记忆系统**：SQLite + FTS5 + 向量混合检索，每个 Agent 独立记忆隔离。
- **Agent 隔离**：每个 Agent 独立的 system prompt、工具白名单、工作区、记忆。
- **交互式适配**：危险命令弹卡片确认，`ask_user_question` 弹选项卡片，无缝连接飞书与 Agent。
- **Lobster v2.0 内核**：12 hooks + 18 extensions + 单事件总线，所有子系统都通过 `defineExtension` 接入。

---

## 功能特性

### 🖥️ 终端 TUI

在终端里直接对话 AI Agent。流式输出、语法高亮、Slash 命令。

- **全自主循环**：reasoning → tool calls → response。
- **多 Provider 支持**：Claude、OpenAI。
- **Sub-Agent 委派**：大任务分拆到独立子 Agent。
- **5 级上下文压缩**：snip → summarize → emergency truncation → collapse。
- **Slash 命令**：`/clear` `/compact` `/cost` `/tools` `/cancel` `/daemon` `/exit` `/help`（详见下方表格）。
- **Token 预算条**：颜色编码的上下文压力指示。

### 📱 飞书 Bot

飞书话题群里发消息，Agent 自动启动独立编程会话，流式卡片实时展示输出。

- **话题群 + 普通群**：自动识别群类型，话题群每话题独立上下文。
- **流式卡片**：实时 Markdown 渲染，不需要截图。
- **多 Bot**：多个 daemon 进程，独立 Agent 配置 + 独立 Memory。
- **交互式确认**：危险命令弹卡片确认，`ask_user_question` 弹选项卡片。
- **会话持久化**：daemon 重启自动恢复会话上下文。
- **TUI ↔ IM 互通**：TUI 中 `/daemon` 浏览和接管飞书会话。

### 🧩 Agent 工作区

每个 Agent 有独立的身份、记忆和工作空间：

```
~/.my-agent/agents/<id>/
  AGENTS.md      → 行为规则
  SOUL.md        → 人格定义
  IDENTITY.md    → 身份标识
  memory.db      → 隔离记忆数据库
  sessions/      → 会话持久化
```

### 🧠 更多功能

- **Memory**：SQLite + FTS5 + 向量混合检索。
- **Skills**：Markdown 文件教 Agent 新工作流。
- **Self-Evolution**：自动分析 trace 并生成 Skill 提案。
- **Session**：命名会话、保存、加载。

---

## 5 分钟快速接入（飞书 Bot）

### Step 1: 创建飞书应用

打开 [飞书开放平台](https://open.larkoffice.com/app)，点击「创建企业自建应用」。

### Step 2: 获取凭证

进入应用详情 →「凭证与基础信息」，复制 **App ID** 和 **App Secret**。

### Step 3: 添加权限

进入「权限管理」，至少添加以下权限：

- `im:message` — 接收和发送消息
- `im:message:send_as_bot` — 以机器人身份发送消息
- `im:message:readonly` — 读取消息
- `im:chat:read` — 读取群信息

### Step 4: 安装 & 配置 Bot

```bash
# 安装
bun install

# 配置 API Key
cp .env.example .env
# 编辑 .env: ANTHROPIC_API_KEY=sk-ant-xxx

# 交互式配置 Bot
bun bot
```

按提示输入 Lark App ID、App Secret，选择或创建 Agent。

### Step 5: 配置事件订阅

回到飞书开放平台，进入「事件与回调」：

1. **订阅方式**：选择「使用长连接接收事件」。
2. **添加事件**：搜索添加 `im.message.receive_v1`（接收消息 v2.0）。
3. **启用回调**：切换到「回调配置」tab，开启「卡片回传交互」（`card.action.trigger`）。

### Step 6: 启动 Daemon

```bash
bun daemon <agent-name>
```

### Step 7: 发版 & 建群验证

1. 飞书后台「版本管理与发布」→「创建版本」→ 仅自己可见 → 发布。
2. 飞书创建一个话题群 → 群设置 → 群机器人 → 添加机器人。
3. 在群里发一条消息，确认机器人响应。

---

## 本地开发（终端 TUI）

```bash
# 克隆 & 安装
git clone https://github.com/Chengchcc/my-agent-dev.git
cd my-agent-dev
bun install
cp .env.example .env  # 配置 ANTHROPIC_API_KEY

# 启动 TUI
bun tui

# 或 headless 单次运行
bun agent "Explain the authentication flow"
```

---

## CLI 命令

| 命令 | 说明 |
|------|------|
| `bun tui` | 启动终端 UI |
| `bun agent "<prompt>"` | Headless 单次运行 |
| `bun bot` | 交互式配置 Bot + Agent |
| `bun daemon <agent>` | 启动飞书 Bot daemon |
| `bun daemon list` | 列出运行中 daemon |
| `bun daemon stop <agent>` | 停止 daemon |

每个 CLI-bearing extension 还导出自己的 `my-agent <name> ...` 子命令：

| 子命令 | 说明 |
|---|---|
| `my-agent trace ...` | trace 查询与导出 |
| `my-agent memory ...` | 记忆增删查 |
| `my-agent skills ...` | Skill 列表/启停 |
| `my-agent evolution list / promote / discard / stats` | 进化提案管理 |
| `my-agent mcp ...` | MCP server 管理 |

### TUI Slash 命令

内建 slash 命令（位于 `src/application/slash/builtin/`）：

| 命令 | 说明 |
|------|------|
| `/help` | 显示可用命令 |
| `/clear` | 清除对话 |
| `/compact` | 手动触发上下文压缩 |
| `/cost` | 查看本会话 token 使用 |
| `/tools` | 列出/切换工具 |
| `/cancel` | 取消当前 turn |
| `/daemon` | 浏览运行中 daemon 的会话 |
| `/exit` | 退出 |

> **M1 已知问题**：扩展贡献的 slash 命令（`/trace` `/memory` `/evolve` 等）目前在前端尚未挂载，会被静默忽略。修复在合并前的 P0 patch 中跟进。

---

## 配置

### Lark Bot 配置

Lark Bot 配置存储在 SQLite agent registry (`~/.my-agent/agents.db`) 中，每 agent 一条记录。通过 CLI 交互式配置：

```bash
# 创建 Agent 并配置 Lark Bot
bun cli agent create
# 或事后管理 Lark 配置
bun cli agent lark set -a <agent-name>
```

配置字段：`appId`（飞书应用 ID）、`appSecretEnv`（App Secret **环境变量名**，不存明文）。

### settings.yml（全局配置）

```yaml
# ~/.my-agent/settings.yml
llm:
  provider: claude
  model: claude-opus-4-7
context:
  tokenLimit: 200000
security:
  allowedRoots:
    - ~/projects
```

---

## 配置文件位置

| 路径 | 说明 |
|------|------|
| `~/.my-agent/agents.db` | SQLite agent registry（Lark 配置等） |
| `~/.my-agent/settings.yml` | 全局 Agent 配置 |
| `~/.my-agent/agents/<id>/` | Agent 工作区（identity.md、sessions/、memory/） |
| `~/.my-agent/agents/<id>/logs/` | Daemon 日志 |
| `~/.my-agent/agents/<id>/daemon.sock` | Daemon Unix socket |
| `~/.my-agent/trash/` | 已删除 agent 备份（30 天自动清理） |

---

## 项目结构

```
my-agent/
├── bin/                        # CLI 入口（薄封装层）
│   ├── my-agent-cli.ts         # CLI dispatch
│   └── my-agent-daemon.ts      # Daemon 进程入口
├── src/
│   ├── kernel/                 # 扩展系统核心（DI 容器、事件总线、Hook/RPC）
│   │   ├── kernel.ts           # createKernel() 工厂
│   │   ├── define-extension.ts # defineExtension() 扩展注册
│   │   ├── event-bus.ts        # 发布/订阅事件总线
│   │   ├── hook-container.ts   # 12-hook 调度器（3 种模式）
│   │   ├── extension-registry.ts # 能力 + slash 收集
│   │   └── rpc-registry.ts     # JSON-RPC 方法注册表
│   ├── application/
│   │   ├── contracts/          # 跨边界数据契约（事件、信封、持久化格式、codecs）
│   │   ├── ports/              # 抽象接口（防腐层）
│   │   ├── slash/              # Slash 命令注册表 + 内建命令（A18.5）
│   │   └── usecases/           # 纯编排函数（无 IO）
│   ├── domain/                 # 纯领域实体（Session, Turn, TurnEvent, Identity 等）
│   ├── extensions/             # 18 个扩展（provider, memory, session, tools, evolution, …）
│   │   ├── presets.ts          # 扩展预设（TUI / headless / daemon）
│   │   ├── frontend.tui/       # Ink/React 终端 UI
│   │   ├── frontend.lark/      # 飞书 Bot 适配器
│   │   └── ...
│   ├── infrastructure/         # 适配器实现（LLM、transport、memory、paths、config）
│   └── cli/                    # CLI 子命令路由
├── skills/                     # Skill 定义
├── docs/                       # Spec + Plan 文档
└── tests/                      # 测试
```

---

## 开发

```bash
bun install              # 安装依赖
bun tui                  # 启动 TUI
bun tsc                  # 类型检查
bun test                 # 运行测试
bun run check:all        # 完整 CI（tsc + tests + arch guard + deadcode）
bun run lint             # ESLint
```

## License

MIT
