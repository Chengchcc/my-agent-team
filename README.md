<p align="center">
  <strong>Multi-Agent Team Runtime — 四个 Oma 后端可切换，Agent 工作区即配置文件，Web 和飞书双端实时可见</strong>
</p>

![Bun](https://img.shields.io/badge/runtime-Bun-14151a?style=flat-square&logo=bun)
![TypeScript](https://img.shields.io/badge/language-TypeScript-3178c6?style=flat-square&logo=typescript)
![Next.js](https://img.shields.io/badge/framework-Next.js-000000?style=flat-square&logo=nextdotjs)
![Tailwind CSS](https://img.shields.io/badge/UI-Tailwind_CSS-38BDF8?style=flat-square&logo=tailwindcss)
![SQLite](https://img.shields.io/badge/database-SQLite-003B57?style=flat-square&logo=sqlite)
![Drizzle ORM](https://img.shields.io/badge/ORM-Drizzle-2962FF?style=flat-square)
![Elysia](https://img.shields.io/badge/http-Elysia-2C2C2C?style=flat-square)
![MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)
<!-- 0.2.0 发正式版后，把这个 badge 改回 /v/@chengchenccc/oh-my-agent（latest） -->
[![npm version (rc)](https://img.shields.io/npm/v/@chengchenccc/oh-my-agent/rc?style=flat-square)](https://www.npmjs.com/package/@chengchenccc/oh-my-agent?activeTab=versions)
[![npm downloads](https://img.shields.io/npm/dm/@chengchenccc/oh-my-agent?style=flat-square)](https://www.npmjs.com/package/@chengchenccc/oh-my-agent)

---

my-agent-team 是一个**团队级 Agent 运行时**。每个 Agent 有独立的工作区（身份、技能、MCP、记忆都是工作区里的文件），运行时可以选择自研 oma 或 claude / pi / omp 四种后端，各自用原生 session 续接上下文。对话在 Web 控制台和飞书群里实时同步，Agent 由 Product Backend 按 Run 调度执行：不掉消息、不重复、所有端看到的状态一致。

## ✨ Highlights

- **四后端可切换** — 自研 oma 与 claude / pi / omp 任一运行，agent 级配置、每 Run 冻结，切后端不丢上下文（各自原生 session 续接，产品只存一个引用）
- **Agent 工作区即配置** — 身份（SOUL/USER）、技能、MCP、产品工具、知识库都是工作区里的文件（AGENTS.md / `.mcp.json` / `.<kind>/skills`），后端自动桥接，人类可直接改文件
- **一个对话一个 Agent** — 对话是 Agent session 的产品态投影；多 Agent 协作 = 多个对话投影到同一件事情（Work）上
- **多 Provider 多协议** — 支持 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 三种 API 协议；builtin provider 只需环境有 API Key 即自动生效；用户通过 `~/.oma/models.yml` 添加自定义 provider
- **Thinking/Reasoning** — 全链路支持 Anthropic extended thinking、DeepSeek reasoning_content、OpenAI reasoning_effort；Web UI 可选 thinking level
- **终端 TUI（oma）** — 独立交互式终端：流式渲染、工具调用/结果、thinking 与 tool detail 切换、mermaid ASCII 图、`/resume` 与 `/fork`、模型选择持久化到项目 `.oma/settings.json`，composer loader 实时摘要当前动作
- **双端同步** — Web 控制台 + 飞书（Lark IM）Bot，同一条对话两边实时可见
- **对话账本** — canonical conversation store（conversation_ledger）：人发的消息、Agent 的终态提交、错误气泡、撤销标记都落在这里，端只做渲染，不持有事实
- **Agent Run 执行链** — 每个 Run 由 Agent Backend spawn 一次性子进程（oma 走 stdin/stdout JSONL，claude / pi / omp 各用自己的 argv 与输出格式），`BackendRunOutcome` 是唯一终态，terminal commit 在一个事务里写入 History + Context
- **Agentic Workflow** — 声明式节点图（agent/script/human + 条件边 + cron 触发）：agent 节点派发 Agent Run、script 节点进程沙箱执行、human 节点 Web 表单；产物经 Artifact 在节点间流转，Web 可视化编排与调试
- **Product Tools** — History 读写等产品能力由 Product Backend 统一执行（幂等 + 审计）
- **SQLite 单文件存储** — backend.db，零运维部署

## 📸 Screenshots

| Agents | MCP Servers | Knowledge Packs |
|---|---|---|
| <img src="docs/screenshots/team.png" width="280" alt="Team agents" /> | <img src="docs/screenshots/mcp.png" width="280" alt="MCP catalog" /> | <img src="docs/screenshots/knowledge.png" width="280" alt="Knowledge packs" /> |

| System (Observability) | Workflow Orchestrator | Chat Run Console |
|---|---|---|
| <img src="docs/screenshots/system.png" width="280" alt="System telemetry overview" /> | <img src="docs/screenshots/workflow-execution.png" width="280" alt="Live DAG orchestrator" /> | <img src="docs/screenshots/chat.png" width="280" alt="Chat run console" /> |

| Oma TUI — real session | Oma TUI — tools | Oma TUI — mermaid |
|---|---|---|
| <img src="docs/screenshots/oma-tui-real.png" width="280" alt="Oma TUI real session" /> | <img src="docs/screenshots/oma-tui-tools.png" width="280" alt="Oma TUI tools" /> | <img src="docs/screenshots/oma-tui-mermaid.png" width="280" alt="Oma TUI mermaid" /> |

## 🚀 快速开始

两种走法：装一个能用的（oma 和 backend + web 一起下发），或者在源码仓库里跑开发环境。

### 装一个能用的

一行命令装好 oma 和整套后端 + Web：

```bash
curl -fsSL https://raw.githubusercontent.com/Chengchcc/my-agent-team/master/scripts/install.sh | OMA_VERSION=rc sh
```

`OMA_VERSION=rc` 走 npm 的 `rc` 通道，因为带 `oma gateway` 这套命令的版本目前还没有发到 `latest`；等正式版上了 `latest`，把那截去掉即可。想直接装包也行：

```bash
bun add -g @chengchenccc/oh-my-agent@rc
```

脚本按顺序做三件事：装 [Bun](https://bun.sh)（缺了才装）、装 `@chengchenccc/oh-my-agent`、把 gateway 产物下到 `~/.oma/gateway/`。它不会替你启动服务。

> Bun 默认不执行依赖的 postinstall（`bun add -g` 会提示 `Blocked N postinstalls`），所以产物不会在装包时自动下载：上面的一行命令和下面的手动安装都会显式跑一次 `oma gateway fetch`。想看被拦下了哪些脚本，用 `bun pm -g untrusted`。

启动（前台，Ctrl-C 收掉）：

```bash
oma gateway up
```

想让它跑在后台（登录服务器、关掉终端也不影响）：

```bash
oma gateway up -d      # 健康后才返回，日志在 ~/.oma/gateway/up.log
oma gateway status     # 版本、进程、健康、登录口令
oma gateway down       # 停掉后台那个
oma update             # 以后升级：CLI 和产物一起，后台 gateway 顺手重启
```

前台后台都会把地址和登录口令打印出来，浏览器打开 `http://127.0.0.1:3001/login` 即可。服务只绑 `127.0.0.1`，不上局域网。

口令不是固定的：首次启动时随机生成，写进 `~/.oma/gateway-secrets.json`（权限 0600），忘了随时再查：

```bash
oma gateway status                     # 打印 user-001 / <口令>
cat ~/.oma/gateway-secrets.json
```

想换成自己记得住的，有两条路：

- **Web 设置页**（推荐）：Settings → Login password → Change password。只存 **argon2id 哈希**，**立即生效、不用重启**；
- **命令行**：改 `~/.oma/gateway-secrets.json` 里的 `MOCK_PASSWORD`，或直接 `oma gateway passwd`（生成一个新的随机口令）。gateway 在运行时 `passwd` 会连后端那份哈希一起更新；没运行时需要重启。

两者同时存在时**设置页那份（哈希）优先**。`export MOCK_PASSWORD=...` 对 gateway 不起作用：产物清单里的值优先于进程环境。登录页只填密码，`user-001` 只是标识。

> 源码方式（`bun run dev`）的口令来自 web 的 `MOCK_PASSWORD`：模板在 `apps/web/.env.example`（值是 `admin`），`scripts/predev.sh` 首次运行会把它换成随机值，生成的文件不进版本库。

不想用脚本就手动装：

```bash
bun add -g @chengchenccc/oh-my-agent
oma gateway fetch   # 下载并校验 gateway 产物（这一步不能省，见下）
oma gateway up
```

常用命令：

| 命令 | 做什么 |
|---|---|
| `oma gateway up` | 前台起 backend + web，Ctrl-C 时按依赖逆序优雅收掉 |
| `oma gateway up -d` | 同上，但放后台：健康后返回，可关终端 |
| `oma gateway down` | 停掉 `up -d` 起的那个（认不出是本栈的进程就拒绝动手） |
| `oma gateway status` | 装了哪个版本、进程在不在、健康与否、登录口令 |
| `oma gateway fetch` | 只下载校验产物，幂等；删掉版本目录可强制重下 |

`oma gateway up|fetch` 都接受 `--version <版本>` 指定产物版本。

升级也是它自己的一条命令：

```bash
oma update           # CLI 和 gateway 产物一起升到最新；后台 gateway 在跑就顺手重启
oma update --check   # 只看不装：装了哪个、发布了哪个，有更新时退出码是 1
```

`oma update` 按 npm 上的最高版本走（`latest` 与 `rc` 里取高的那个），所以不用记自己在哪条通道。它不下行降级，除非 `oma update --version <版本>` 显式指定。装法是认不出来的那种（手工拷贝、别的包管理器），它只打印该跑什么，不替你猜。TUI 里也会在启动时提示一次新版本。

产物和状态分开落盘，升级换代码不动数据：

```
~/.oma/gateway/versions/<版本>/   代码：backend bundle、drizzle 迁移、资源、web
~/.oma/gateway-data/              数据：SQLite、Agent 工作区、workflow
~/.oma/gateway-secrets.json       登录口令与后端 token
```

**依赖：** `bun`、`tar`、`zstd`。模型 Key 按下面「配置模型 Provider」给（`ANTHROPIC_API_KEY` 等），`oma gateway up` 会把当前环境透传给后端。

> **自定义 provider 在 gateway 里多一道门。** 独立 CLI 会依次读 `$OMA_HOME/models.yml`、`~/.oma/models.yml`、`./.oma/models.yml`；但产品里的 agent 子进程**只读 `$OMA_HOME/models.yml`** —— 工作区和 `~/.oma` 都是 agent 自己的 bash 工具能写的地方，读它们等于允许一次 Run 劫持下一次的 provider baseUrl 和 key。所以要在 gateway 里用自定义 provider：把 `models.yml` 放到某个目录，并**启动 gateway 时把 `OMA_HOME` 指到它**（后台常驻就写进服务单元）。`oma gateway status` 会打印它当前用的是哪份目录。
>
> 另外 provider 的 key 也要在那个环境里（`apiKeyEnv` 声明的名字，如 `ZAI_API_KEY`），否则会看到模型却跑不动，报 `model not found in catalog: <provider>/<model>`。

装好的 oma 单独用也没问题：直接敲 `oma` 开 TUI，`oma -p "..."` 跑一次性问答。

> 装完如果 `oma gateway` 报未知命令，说明拿到的是 `latest` 上的 0.1.x（还没有 gateway 命令面）：改用 `@rc`，或者走下面的源码方式。

### 从源码跑（开发）

**前置条件：** [Bun](https://bun.sh) >= 1.3

```bash
bun install

# 设置至少一个 provider 的 API Key
export ANTHROPIC_API_KEY=sk-ant-...
# 或 OPENAI_API_KEY / DEEPSEEK_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY

bun run dev
```

`dev` 会并行启动 backend（HTTP/SSE）和 web（Next.js）。打开：

| 服务 | 地址 |
|---|---|
| Web 控制台 | `http://localhost:3001` |
| Backend API | `http://localhost:3000` |

### 配置模型 Provider

Builtin provider 只需环境变量有对应的 API Key 即自动可用：

| Provider | 环境变量 | 可用模型 |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | Claude Opus 4.8, Sonnet 5, Haiku 4.5 |
| OpenAI | `OPENAI_API_KEY` | GPT-5.4, GPT-5.2, GPT-5 Mini, o4 Mini |
| DeepSeek | `DEEPSEEK_API_KEY` | DeepSeek V4 Flash, V4 Pro |
| Groq | `GROQ_API_KEY` | Llama 3.3 70B |
| OpenRouter | `OPENROUTER_API_KEY` | Claude Sonnet 5 + 更多 |

自定义 provider 或模型覆盖，在 `~/.oma/models.yml` 中声明：

```yaml
providers:
  my-provider:
    api: openai-completions          # 或 anthropic-messages / openai-responses
    baseUrl: https://my-api.example.com/v1
    apiKeyEnv: MY_API_KEY
    models:
      - id: my-model-v1
        name: My Custom Model
        reasoning: true
        contextWindow: 128000
        maxTokens: 8192
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }
        thinking:
          mode: effort                # effort | budget | adaptive
          efforts: [off, low, high]
        compat:
          thinkingFormat: deepseek    # deepseek | qwen | zai | openrouter
          maxTokensField: max_tokens  # 或 max_completion_tokens
```

详细架构见 [`docs/architecture/system-overview.md`](docs/architecture/system-overview.md)（执行链、分层、不变量）。

> **子进程从哪来**：每个 Run 按 agent 绑定的后端种类选 adapter（oma / claude / pi / omp），各自 spawn 一次。`oma gateway up` 会把 `OMA_BIN` 指到自己的可执行文件，不用手工配；源码开发时 `bun run dev` 直接跑 `apps/oh-my-agent/src/cli.ts`。只有手工部署（不用 `oma gateway up`）才需要自己把 `OMA_BIN` 指到 `apps/oh-my-agent/dist/cli.js` 的绝对路径（详见 `apps/backend/.env.example`）。
> **npm 包**：`@chengchenccc/oh-my-agent` —— [npmjs](https://www.npmjs.com/package/@chengchenccc/oh-my-agent)。`latest` 停在 0.1.x，带 `gateway` 命令的版本在 `rc` 通道：`bun add -g @chengchenccc/oh-my-agent@rc`。

## 🔐 安全模型（单操作员）

本项目按**单操作员、系统本地部署**的威胁模型设计：web 登录、BFF 与 backend 共享 token 的所有会话是**同一个操作员**，没有多租户隔离。请勿把它当作多用户服务暴露到公网——不同登录用户可互相读写会话、Run、Agent 配置并代答 HITL 审批。

由此推论的产品边界：

- MCP 服务器 CRUD 与工具调用、Provider key 配置等"管理员面"是操作员能力，不加第二用户体系；
- workflow script 节点默认禁用（`WORKFLOW_SCRIPTS_ENABLED=1` 显式开启），开启后脚本在 bwrap/sandbox-exec 下运行（无网络、不可读 dataDir/.env、独立 PID namespace）；
- Lark 入站消息受 `agent.lark.allowed_senders` open_id 白名单约束，bot 发送者一律丢弃；
- 全部 secret（provider key、MCP headers）只存于服务端，HTTP 读取侧一律脱敏。

## 📦 仓库结构

```
apps/
  backend/       Product Backend — HTTP/SSE、账本、Agent Context、Agent Run、Workflow、Artifact、Product Tools MCP、workspace bridge
  oh-my-agent/   Oma CLI — print/json/rpc/TUI 模式，被 backend 按 Run spawn
  web/           Web 控制台 — Next.js 15 + shadcn/ui + React Query
  lark-bot/      飞书 Bot 适配器

packages/
  message/             协议层：Message 类型、ChatModel、Tool、stream-utils（无 run loop）
  agent-contract/      Agent Backend 中立契约：BackendRunInput/Outcome/Event/Segment
  adapter-oma-agent/   Adapter — spawn 自研 child、JSONL 读写、steer/abort/approval、并发上限
  adapter-claude-agent/ Adapter — spawn claude CLI（stream-json、--resume/--mcp-config）
  adapter-pi-agent/    Adapter — spawn pi CLI（--session/--provider/--model）
  adapter-omp-agent/   Adapter — spawn omp CLI（-r/--thinking）
  adapter-mcp/         MCP client adapter — 外部 MCP server 接入
  workflow/            Agentic Workflow DSL 纯域层（节点图、JSON-Logic、computeNext 引擎）
  sandbox/             进程沙箱 — workflow script 节点 / oma eval 工具的隔离执行
  ai/                  多 API Provider：ApiImplementation 注册表 +
                       createProvider 工厂 + fetchSSE 共享传输 + per-API compat 系统 +
                       BUILTIN_CATALOG + parseCatalogYAML 运行时模型配置
  source-fetch/        git/zip 源物化基座（oma marketplace 与 backend skill-pack 共用）
  tui/                 终端 UI 工具箱（oma TUI 的 editor/markdown/mermaid 支撑）
  api-contract/        跨进程类型契约（SSE 事件、Eden Treaty）
  config/              配置加载
  test-helpers/        测试工具（echoModel）
```

## 📖 文档

| 文档 | 说明 |
|---|---|
| [项目 Wiki](docs/README.md) | 现状（`architecture/`）、决策（`adr/`）、指南（`guides/`）、路线（`roadmap.md`）四个区；首页有「按任务找页」的路由表 |

## 🛠 开发
```bash
bun run format      # Biome 格式化
bun run lint        # Biome + ESLint
bun run typecheck   # tsc --noEmit（全仓）
bun run test        # 全仓测试
bun run build       # 全仓构建（turbo）
```

> **数据库升级策略**：迁移只保证 fresh-boot 路径。改动 schema 后若旧开发库
> 启动异常，直接删掉 `apps/backend/.backend-data/` 重启即可（开发数据，非持久
> 事实）：不存在 in-place 升级路径，旧库兼容问题不修。

## 📄 License

MIT
