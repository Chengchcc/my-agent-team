# my-agent-team

**One conversation, four coding agents.**

![Bun](https://img.shields.io/badge/runtime-Bun-14151a?style=flat-square&logo=bun)
![TypeScript](https://img.shields.io/badge/language-TypeScript-3178c6?style=flat-square&logo=typescript)
![Next.js](https://img.shields.io/badge/framework-Next.js-000000?style=flat-square&logo=nextdotjs)
![Tailwind CSS](https://img.shields.io/badge/UI-Tailwind_CSS-38BDF8?style=flat-square&logo=tailwindcss)
![SQLite](https://img.shields.io/badge/database-SQLite-003B57?style=flat-square&logo=sqlite)
![Drizzle ORM](https://img.shields.io/badge/ORM-Drizzle-2962FF?style=flat-square)
![Elysia](https://img.shields.io/badge/http-Elysia-2C2C2C?style=flat-square)
[![npm version (rc)](https://img.shields.io/npm/v/@chengchenccc/oh-my-agent/rc?style=flat-square)](https://www.npmjs.com/package/@chengchenccc/oh-my-agent?activeTab=versions)
[![npm downloads](https://img.shields.io/npm/dm/@chengchenccc/oh-my-agent?style=flat-square)](https://www.npmjs.com/package/@chengchenccc/oh-my-agent)

---

my-agent-team 是一个**团队级 Agent 运行时**：每个 Agent 一个工作区，身份、技能、MCP 与记忆都是工作区里的文件；oma / claude / pi / omp 四个 harness 任选，各自用原生 session 续接上下文；对话在 Web 控制台与飞书之间实时同步，所有端渲染的是账本里的同一份事实。

## 🚀 Getting Started

### 从源码跑（四步）

**1. 前置条件**

- **Bun 1.3.14 或更新**：最低线是 `package.json` 里 `packageManager` 锁的 `bun@1.3.14`；CI 与发布实际跑 `1.4.4`。
- **系统依赖**：`ripgrep`、`bubblewrap`（CI 装的就是这两个），以及 `openssl`（`scripts/predev.sh` 用它生成开发密钥，缺了会直接退出）。
- **Anthropic 凭据**：`ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`，二选一。源码启动器只认这一家，缺了 `scripts/dev.sh` 会 `exit 1`。

判据：`bun --version` 输出不低于 1.3.14。

**2. 安装依赖**

```bash
bun install
```

判据：退出码 0，`node_modules/` 已生成。

**3. 设置 Anthropic 凭据并启动**

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # 或 export ANTHROPIC_AUTH_TOKEN=...
bun run dev
```

`bun run dev` 先跑 `predev`（`scripts/predev.sh`：从 `.env.example` 生成 `apps/backend` 与 `apps/web` 的 `.env`，自动生成 `BACKEND_AUTH_TOKEN`、`SESSION_SECRET`、`MOCK_PASSWORD`，补齐 drizzle 迁移与 Monaco 资产），再跑 `dev`（`scripts/dev.sh`：校验 Anthropic 凭据、清掉 3000/3001 上的残留进程、并行起 backend 与 web）。`BACKEND_AUTH_TOKEN` 是环境变量 schema 里唯一必填项，这一步会替你生成。

判据：终端打印登录地址与两个 PID（见第 4 步）。

**4. 成功判据**

| 检查 | 期望 |
|---|---|
| 终端输出 | 打印 `Login at http://localhost:3001/login` 与 backend/web 两个 PID |
| Backend | `curl -s http://127.0.0.1:3000/health` 返回 `{"status":"ok"}` |
| Web 控制台 | `http://localhost:3001` 可打开，登录页是 `http://localhost:3001/login` |
| 登录口令 | `apps/web` 下由 `predev` 生成的 `.env` 里的 `MOCK_PASSWORD=` |

`predev` 首跑会把模板值 `admin` 换成随机值；后端只在**全新数据目录的第一次启动**采纳它，之后改 env 不再生效。忘了就跑 `bash scripts/reset-login-password.sh`，再重启 backend。

**换别的 provider**

`bun run dev` 的 Anthropic 检查是启动脚本的门槛，不是后端运行时的要求：只设 `OPENAI_API_KEY` 之类的 key，`scripts/dev.sh` 仍会 `exit 1`。没有 Anthropic key 时，用两个终端绕开启动器：

```bash
bun run predev       # 生成 .env 与密钥（只需一次）

# 终端 1
export OPENAI_API_KEY=sk-...
bun run dev:backend  # http://127.0.0.1:3000

# 终端 2
bun run dev:web      # http://localhost:3001
```

判据与第 4 步相同。各家 key 的对应关系：

| Provider | 环境变量 |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Groq | `GROQ_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |

设了哪家的 key，哪家的 builtin provider 就可用；自定义 provider 与模型覆盖写在 `~/.oma/models.yml`（gateway 场景的额外限制见「安全模型」）。

### 直接装预编译产物

不想跑源码，就装一个能用的（oma + backend + web 一起下发）：

```bash
curl -fsSL https://raw.githubusercontent.com/Chengchcc/my-agent-team/master/scripts/install.sh | OMA_VERSION=rc sh
oma gateway up        # 前台；-d 放后台，健康后才返回
```

脚本会按需装 Bun、装 `@chengchenccc/oh-my-agent`，并把 gateway 产物下到 `~/.oma/gateway/`；它不替你启动服务。`OMA_VERSION=rc` 走 npm 的 `rc` 通道：带 `oma gateway` 命令的版本还没发到 `latest`。登录地址与口令由 `oma gateway up` 打印；也可 `oma gateway status` 再查，口令落在 `~/.oma/gateway-secrets.json`（0600）。改口令：Web 设置页 Settings → Login password（立即生效），或 `oma gateway passwd`；两者都在时设置页的哈希优先。

常用命令：

| 命令 | 做什么 |
|---|---|
| `oma gateway up` / `up -d` | 起 backend + web（前台 / 后台） |
| `oma gateway status` | 版本、进程、健康、登录口令 |
| `oma gateway down` | 停掉后台那个 |
| `oma update` | CLI 与产物一起升级（`--check` 只看；按 latest/rc 取高者，不下行降级） |

`oma gateway up` / `fetch` 都接受 `--version <版本>` 指定产物版本。

手动装也行：`bun add -g @chengchenccc/oh-my-agent@rc` → `oma gateway fetch` → `oma gateway up`（`fetch` 不能省：Bun 默认不跑依赖的 postinstall）。系统依赖是 `bun`、`tar`、`zstd`；代码与数据分开落盘，升级不动 `~/.oma/gateway-data/`。

成功判据与源码方式相同：打开 `http://127.0.0.1:3001/login`，用打印出的口令登录。

## 🏗 架构

```
Surfaces    Web 控制台 · 飞书卡片 · oma TUI
                 │ HTTP / SSE
Backend     Product Backend — 产品事实 + 执行控制面
            conversation_ledger · Agent Run · Workflow · Artifact · 审批
                 │ spawn（ACP）
Adapter     一个 ACP 客户端驱动四个 harness：oma · claude · pi · omp
                 │
Runtime     oma agent loop — 模型 + 工具循环、插件、压缩、todo、权限
            claude / pi / omp 用自己的原生 loop，经同一 ACP 轨接入
                 │
Protocols   Message · ChatModel · Tool · ContentBlock · Workflow DSL
```

**不变量**

- Backend 是唯一事实源；Web、飞书、TUI 只渲染同一份 `conversation_ledger`。
- `BackendRunOutcome` 是 Run 的唯一终态；终态提交在一个事务里写入 History + Context。
- 审批与提问停在 `pending_action`，超时按拒绝处理（fail-closed）。
- Workflow 的路由在节点完成时冻结进 `CompletionRecord.routedTo`，之后不再重算；join 语义是 any-of。
- Agent 配置就是工作区里的文件，每个 Run 冻结一次；切 harness 靠各自的原生 session 续接。
- 四个 harness 是同一 ACP 轨上的四个入口，不是四条执行路径。

## ✨ 功能要点

1. **四个 harness，切后端不丢上下文** — oma / claude / pi / omp 在同一 ACP 轨上运行，各自续接原生 session；配置按 Run 冻结。
2. **工作区即配置** — 身份（`SOUL.md` / `USER.md`）、技能、MCP、知识库都是 Agent 工作区里的文件，后端负责桥接，人可以直接改。
3. **Web 与飞书双端同步** — 同一条对话两边实时可见；Run 卡片流式投影、停止按钮、话题即会话、待回答消息各自成卡。
4. **权限与人在环** — `ask` 把写文件/跑命令隔在审批卡后面，`auto` 由分类器判断高风险动作，`deny` 直接拒绝；问题与回答持久化在 `pending_action`，超时默认拒绝。
5. **Agentic Workflow** — 声明式节点图（agent / script / human + 条件边 + cron），script 节点在进程沙箱里跑，产物经 Artifact 在节点间流转。

## 🔐 安全模型（单操作员）

本项目按**单操作员、系统本地部署**的威胁模型设计：web 登录、BFF 与 backend 共享 token 的所有会话是**同一个操作员**，没有多租户隔离。请勿把它当作多用户服务暴露到公网——不同登录用户可互相读写会话、Run、Agent 配置并代答 HITL 审批。

由此推论的产品边界：

- MCP 服务器 CRUD 与工具调用、Provider key 配置等“管理员面”是操作员能力，不加第二用户体系；
- workflow script 节点默认禁用（`WORKFLOW_SCRIPTS_ENABLED=1` 显式开启），开启后脚本在 bwrap/sandbox-exec 下运行（无网络、不可读 dataDir/.env、独立 PID namespace）；
- Lark 入站消息受 `agent.lark.allowed_senders` open_id 白名单约束，bot 发送者一律丢弃；
- 全部 secret（provider key、MCP headers）只存于服务端，HTTP 读取侧一律脱敏；
- 服务默认只绑 `127.0.0.1`，不做局域网暴露。
- 产品里的 agent 子进程只读 `$OMA_HOME/models.yml`：工作区与 `~/.oma` 都是 agent 的可写区，读它们等于允许一次 Run 劫持下一次的 provider baseUrl 与 key。

## 📦 仓库结构与文档

```
apps/
  backend/       Product Backend — HTTP/SSE、账本、Agent Context、Agent Run、Workflow、Artifact、Product Tools MCP
  oh-my-agent/   Oma CLI — print/json/tui/acp 模式，被 backend 按 Run spawn
  web/           Web 控制台 — Next.js 15 + shadcn/ui + React Query
  lark-bot/      飞书 Bot 适配器

packages/
  message/        协议层：Message 类型、ChatModel、Tool、stream-utils
  adapter-mcp/    MCP client adapter — 外部 MCP server 接入
  workflow/       Agentic Workflow DSL 纯域层（节点图、JSON-Logic、computeNext）
  sandbox/        进程沙箱 — workflow script 节点 / oma eval 工具
  ai/             多 API Provider：注册表 + createProvider + BUILTIN_CATALOG + models.yml
  source-fetch/   git/zip 源物化基座
  tui/            终端 UI 工具箱（editor / markdown / mermaid）
  api-contract/   跨进程类型契约（SSE 事件、Eden Treaty）
  config/         配置加载
  test-helpers/   测试工具（echoModel）
```

| 入口 | 内容 |
|---|---|
| [项目 Wiki](docs/README.md) | 现状（`architecture/`）、决策（`adr/`）、指南（`guides/`）、路线（`roadmap.md`） |
| [架构总览](docs/architecture/system-overview.md) | 分层、执行链、关键不变量 |
| [开发指南](docs/guides/development.md) | 本地开发、测试、提交前门禁 |
| [贡献指引](CONTRIBUTING.md) | 提交规范与 PR 流程 |

开发命令：

```bash
bun run format      # Biome 格式化
bun run lint        # Biome + ESLint
bun run typecheck   # tsc --noEmit（全仓）
bun run test        # 全仓测试
bun run build       # 全仓构建（turbo）
bun run audit       # 契约 / 工作区 / 文档 / UI 四道快门禁
bun run audit:coverage  # oma 运行时语义文件的覆盖率底线
```

> **数据库升级策略**：迁移只保证 fresh-boot 路径。改动 schema 后若旧开发库启动异常，直接删掉 `apps/backend/.backend-data/` 重启即可；不存在 in-place 升级路径，旧库兼容问题不修。

## 📄 License

仓库当前未附带 `LICENSE` 文件。
