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
| 📱 **飞书 Bot** | `bun daemon <profile>` | 话题群发消息 → Agent 自动响应，流式卡片 |

---

## 为什么选择 my-agent

- **结构化 Agent 事件**：16 种 AgentEvent stream，飞书卡片直接用 Markdown 渲染，不需要截图管道
- **内置记忆系统**：SQLite + FTS5 + 向量混合检索，每个 Bot 独立记忆隔离
- **Profile 系统**：每个 Bot 独立的 system prompt、工具白名单、工作区
- **交互式适配**：危险命令弹卡片确认，ask_user_question 弹选项卡片，无缝连接飞书和 Agent

---

## 功能特性

### 🖥️ 终端 TUI

在终端里直接对话 AI Agent。流式输出、语法高亮、Slash 命令。

- **全自主循环**: reasoning → tool calls → response
- **多 Provider 支持**: Claude, OpenAI
- **Sub-Agent 委派**: 大任务分拆到独立子 Agent
- **5 级上下文压缩**: snip → summarize → emergency truncation → collapse
- **Slash 命令**: `/clear` `/compact` `/sessions` `/tasks` `/memory` `/review` `/daemon`
- **Token 预算条**: 颜色编码的上下文压力指示

### 📱 飞书 Bot

飞书话题群里发消息，Agent 自动启动独立编程会话，流式卡片实时展示输出。

- **话题群 + 普通群**: 自动识别群类型，话题群每话题独立上下文
- **流式卡片**: 实时 Markdown 渲染，不需要截图
- **多 Bot**: 多个 daemon 进程，独立 Profile + 独立 Memory
- **交互式确认**: 危险命令弹卡片确认，ask_user_question 弹选项卡片
- **会话持久化**: daemon 重启自动恢复会话上下文
- **TUI ↔ IM 互通**: TUI 中 `/daemon` 浏览和接管飞书会话

### 🧠 Profile 系统

每个 Bot 有独立的身份、记忆和工作空间。

```
~/.my-agent/profiles/<id>/
  AGENTS.md      → 行为规则
  SOUL.md        → 人格定义
  IDENTITY.md    → 身份标识
  memory.db       → 隔离记忆数据库
  sessions/       → 会话持久化
```

### 🧩 更多功能

- **Memory**: SQLite + FTS5 + 向量混合检索
- **Skills**: Markdown 文件教 Agent 新工作流
- **Self-Evolution**: 自动分析 trace 并生成 Skill
- **Session**: 命名会话、保存加载

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

按提示输入 Lark App ID、App Secret，选择或创建 Profile。

### Step 5: 配置事件订阅

回到飞书开放平台，进入「事件与回调」：

1. **订阅方式**: 选择「使用长连接接收事件」
2. **添加事件**: 搜索添加 `im.message.receive_v1`（接收消息 v2.0）
3. **启用回调**: 切换到「回调配置」tab，开启「卡片回传交互」（`card.action.trigger`）

### Step 6: 启动 Daemon

```bash
bun daemon <profile-name>
```

### Step 7: 发版 & 建群验证

1. 飞书后台「版本管理与发布」→「创建版本」→ 仅自己可见 → 发布
2. 飞书创建一个话题群 → 群设置 → 群机器人 → 添加机器人
3. 在群里发一条消息，确认机器人响应

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
| `bun bot` | 交互式配置 Bot + Profile |
| `bun daemon <profile>` | 启动飞书 Bot daemon |
| `bun daemon list` | 列出运行中 daemon |
| `bun daemon stop <profile>` | 停止 daemon |

### TUI Slash 命令

| 命令 | 说明 |
|------|------|
| `/help` | 显示可用命令 |
| `/clear` | 清除对话 |
| `/compact` | 手动触发上下文压缩 |
| `/sessions save <name>` | 保存当前会话 |
| `/sessions load <name>` | 加载已保存会话 |
| `/sessions list` | 列出所有会话 |
| `/tasks` | 显示任务列表 |
| `/memory search <query>` | 搜索记忆 |
| `/review list` | 查看自动生成的 Skills |
| `/daemon` | 浏览运行中 daemon 的会话 |
| `/exit` | 退出 |

---

## 配置

### bots.yml（飞书 Bot）

```yaml
# ~/.my-agent/bots.yml
profiles:
  backend-expert:
    workspace: ~/.my-agent/profiles/backend-expert
    toolProfile: code_editor
    workingDir: ~/projects/api
    permissionTimeoutMs: 60000

bots:
  - larkAppId: cli_xxxxxxxxxxxx
    larkAppSecret: xxxxxxxxxxxxxxxxxxxx
    profileId: backend-expert
    allowedUsers:
      - alice@example.com
```

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
| `~/.my-agent/bots.yml` | Bot + Profile 配置 |
| `~/.my-agent/settings.yml` | 全局 Agent 配置 |
| `~/.my-agent/profiles/<id>/` | Profile 工作区（AGENTS.md, SOUL.md, memory.db） |
| `~/.my-agent/data/` | Daemon PID 文件 |
| `~/.my-agent/sessions/` | TUI 会话持久化 |
| `~/.my-agent/traces/` | Agent 运行 trace |
| `~/.my-agent/memory/` | 全局记忆数据库 |

---

## 项目结构

```
my-agent/
├── bin/                        # CLI 入口
│   ├── my-agent-tui-dev.ts     # TUI 开发入口
│   ├── my-agent.ts             # Headless agent
│   ├── my-agent-cli.ts         # Bot/Daemon 管理 CLI
│   └── my-agent-daemon.ts      # Daemon 进程入口
├── src/
│   ├── agent/                  # Agent loop, context, tool dispatch
│   │   ├── compaction/         # 5-tier context compression
│   │   └── tool-dispatch/      # Tool execution pipeline + middleware
│   ├── cli/tui/                # Ink/React 终端 UI
│   │   ├── commands/           # Slash commands
│   │   ├── components/         # UI components
│   │   ├── hooks/              # State management
│   │   └── views/              # View components
│   ├── config/                 # YAML + Zod 配置系统
│   ├── daemon/                 # IM 桥接层
│   │   ├── daemon.ts           # 中央编排器
│   │   ├── session-manager.ts  # Agent 实例池
│   │   ├── session-handlers.ts # 消息处理器
│   │   ├── interactive-bridge.ts # Permission/Ask 适配
│   │   ├── card-pipeline.ts    # AgentEvent → 飞书卡片
│   │   ├── command-handler.ts  # Slash 命令
│   │   └── cli-commands.ts     # CLI 管理命令
│   ├── evolution/              # 自进化系统
│   ├── im/lark/                # 飞书集成
│   │   ├── client.ts           # Lark API 封装
│   │   ├── event-dispatcher.ts # WS 长连接 + 消息路由
│   │   ├── card-builder.ts     # 卡片构建
│   │   ├── card-handler.ts     # 卡片交互
│   │   └── message-parser.ts   # 消息解析
│   ├── memory/                 # 持久记忆 (SQLite + FTS5 + 向量)
│   ├── mcp/                    # MCP 客户端
│   ├── profile/                # Profile 系统
│   ├── providers/              # Claude + OpenAI providers
│   ├── session/                # 会话持久化
│   ├── skills/                 # Skill 加载 + 注入
│   ├── tools/                  # 内置工具
│   ├── trace/                  # Trace 记录
│   ├── utils/                  # 工具函数
│   ├── runtime.ts              # 单一装配点
│   └── types.ts                # 全局类型
├── skills/                     # Skill 定义
├── docs/superpowers/           # Spec + Plan 文档
└── tests/                      # 测试（658+ tests）
```

---

## 开发

```bash
bun install              # 安装依赖
bun tui                  # 启动 TUI
bun tsc                  # 类型检查
bun test                 # 运行测试
bun run check:all        # 完整 CI (tsc + tests + arch guard)
bun run lint             # ESLint
```

## License

MIT
