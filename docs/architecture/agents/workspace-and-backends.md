---
title: Agent 工作区与多后端
description: 工作区目录与 seed 布局、Workspace Bridge 的每个职责、四个后端各自怎么续接 session、agent-config MCP 的三条通道
tags: [backend, mcp, skills, project]
---

# Agent 工作区与多后端

一句话：本页是 Agent 工作区的权威描述。Agent 的配置、技能、身份与记忆都是工作区文件（`agent.yml` / `AGENTS.md` / `SOUL.md` / `USER.md` / `.<kind>/skills` / `.mcp.json` / `.oma/product-tools.json` / `knowledge/index.md`），Product Backend 用 Workspace Bridge 幂等桥接它们；运行时四个后端可切换，各自用自己的原生 session 续接，产品只存一个不透明引用。

## 范围

覆盖：工作区目录与 seed 布局、谁写谁读 `agent.yml`、bridge 的每个职责与触发点、四后端的 spawn 与续接差异、一个对话一个 Agent 的边界、agent-config MCP 的三条提案通道。

不覆盖：run 执行链与契约（见 [Agent Backend](../execution/agent-backend.md)）、skill pack 的分发（见 [技能包管理](../plugins/skill-pack.md)）、技能的索引与加载（见 [渐进式技能](../plugins/progressive-skill.md)）、Project 与 worktree（见 [Project 与 Worktree](./projects-and-worktrees.md)）、模型与 provider（见 [模型与 Provider](../runtime/models.md)）。

## 实现文件

- `apps/backend/src/features/agent/workspace.ts` — seed 布局与 `agentWorkspaceSlug`
- `apps/backend/src/features/agent/agent-compose.ts` — 工作区根的物化与 `allowedWorkspaceRoots`
- `apps/backend/src/features/agent/workspace-bridge.ts` — 全部桥接动作
- `apps/backend/src/features/agent/agent-config.ts` — `agent.yml` 的 zod schema 与唯一 writer `serializeAgentYaml`
- `apps/backend/src/features/agent/{service,adapter-sqlite,agent-identity}.ts` — 写文件、存 config 缓存、读写 SOUL/USER
- `apps/backend/src/features/agent/agent-config-mcp.ts` — agent-config MCP 的三个工具
- `apps/backend/src/bootstrap/features.ts` — run 级配置冻结与 reconcile 触发
- `apps/oh-my-agent/src/core/settings/workspace-context.ts` — 子进程侧读工作区上下文
- `apps/oh-my-agent/src/core/session/session-file.ts` — 子进程侧 session 目录

## 工作区目录与 seed 布局

```text
<dataDir>/agents/<name-slug>[-N]/
  agent.yml                 # 描述符（创建/更新时由 backend 写出，见下）
  AGENTS.md / CLAUDE.md     # 两份内容相同的独立文件（不是 symlink）
  SOUL.md                   # Agent 身份
  USER.md                   # 用户偏好（由 identity 流程读写）
  manifest.json             # 机器可读清单占位
  knowledge/                # 知识库；index.md 由 bridge 重写
  .oma/skills/  .pi/skills/  .omp/skills/  .claude/skills/
                            # 四个 kind 目录，预先建空；已分配的 pack 软链进来
  .mcp.json                 # 用户 MCP server + product-tools 合并（bridge 是唯一 writer）
  .oma/product-tools.json   # 产品工具 manifest（子进程从这里读）
  projects/<projectId>/     # 已附加项目的 worktree（见 Project 与 Worktree）
```

目录名取 Agent 名字的 slug（同名加 `-2`、`-3` 后缀），显式 id seed 时才用 id 当目录名。`workspacePath` 可以被覆盖，但必须落在允许根内（`<config.workspaceRoot>` 与 `<dataDir>/agents`）：越界直接拒绝，这条检查在创建与更新两条路径上都跑。

`SOUL.md` / `USER.md` 平文进系统提示，`AGENTS.md` 链（含用户级 `~/.oma/AGENTS.md`）包在 `<repo-rules>` 里，`knowledge/index.md` 包在 `<available_knowledge>` 里，cwd 下一层未加载的 `AGENTS.md` 只做指针。子进程只认 `AGENTS.md`，不认 `CLAUDE.md` 与 `GEMINI.md`；`CLAUDE.md` 存在是因为 claude CLI 读它。

## 谁写谁读 agent.yml

- 写：`serializeAgentYaml` 是唯一的 writer，只在 create 与 update 时落盘。
- 读：读路径只有 DB 的 `config` 列。HTTP 响应、派发、list、getById 全部读缓存列，**没有任何代码读回 `agent.yml`**。
- 后果：手改 `agent.yml` 不生效，会在下一次 update 被缓存覆盖；Agent 用自己的 write 工具改它同样无效。

## Workspace Bridge

`workspace-bridge.ts` 的每个函数都是幂等 reconcile，可以反复跑：

| 动作 | 效果 |
|---|---|
| `reconcileSkillLinks` | 在 `<KIND_DIR[kind]>/skills/` 下为每个 READY pack 建软链（`claude_code → .claude`），删掉不再分配的链接；某个 slot 上是用户自己的真实目录时不覆盖 |
| `writeMcpConfig` | 写工作区根 `.mcp.json`（`$schema` + `mcpServers`），空列表等于删除该文件。per-kind 的 bearer 写法都写进去（pi 的 `bearerTokenEnv`、omp 的 `bearer_token_env_var`、claude 用 `${VAR}` 展开的 header），**值只写变量名，token 经 spawn env 进来** |
| `writeProductToolsManifest` | 写 `.oma/product-tools.json`，空 manifest 等于删除文件 |
| `reconcileKnowledgeResources` | 为每个知识包建 `knowledge/<packId>` 软链，并重写 `knowledge/index.md` |
| `writeClaudeSettings` | 写 `.claude/settings.json`，预放行产品工具的读接口（claude 在 root 下不能用 `bypassPermissions`，只能这么绕） |
| `reconcileAgentResources` | 上面几项的组合，外加 `extraRoots`（项目 worktree）只桥 `.mcp.json` 与 product-tools |
| `bridgeWorktreeRoot` | 任务 worktree 专用：只写 `.mcp.json` 与 product-tools manifest |

触发点：agent 创建与更新（`reconcileAgent`）、skill pack 安装/分配变化、MCP server 增删改、以及每次 spawn 前由执行服务调 `rewriteWorkspaceBridge` 重写 `.mcp.json` 与 product-tools manifest——所以 bridge 是这两个文件的唯一作者。

### 知识包的 frontmatter 与渐进式加载

`knowledge/index.md` 会被注入每轮的 `<available_knowledge>`，所以它只带判断要不要打开某个文件所需的东西：路径，加上文件自己在开头声明的一行元数据。

```markdown
---
title: Run lifecycle
description: 一次 Run 怎么结束；改执行链之前读这个
tags: [runs, backend]
hide: true        # 仍然可读可搜，只是不进注入的索引
---
```

行的形状是 `` - `runs/lifecycle.md` — Run lifecycle · 一次 Run 怎么结束 · [runs, backend] ``。没有 frontmatter 的文件按路径单独列出（老包照常能用），`hide: true` 的从索引里略过。正文永远不进索引：要读内容就调召回工具。

召回由知识 MCP server 提供（`features/knowledge/mcp-server.ts`，agent 有 READY 包时才并进 `.mcp.json`，作用域是该 agent 的 `knowledge/` 目录）：

| 工具 | 行为 |
|---|---|
| `knowledge_search {keywords[], tags?}` | 每个关键词都要命中（AND），可选按 frontmatter tag 过滤；**只匹配正文，不匹配 frontmatter**；返回最多 20 个文件，每个带 title、description、tags 与 3 行命中上下文 |
| `knowledge_read {path}` | 读一个文件的正文（frontmatter 已剥掉，与 `skill_load` 一致），上限 256K |

索引与召回工具共用同一个 frontmatter 解析器（`features/knowledge/frontmatter.ts`），所以注入的元数据与搜索结果的元数据不会各说一套。

### 内置知识包就是本目录

产品首次启动会把这个仓库的 `docs/architecture/` 直接拷成内置知识包（包名 `architecture`，`<dataDir>/knowledge/architecture`，然后软链进每个 Agent 的 `knowledge/`）。所以：

- 这一区每个页面的 frontmatter 就是注入索引里那一行，`audit:docs` 会拦住缺 title/description 的页；
- 改了页面（不改 frontmatter）只是索引文字变了，包内容要等重新播种才更新——seed 只做一次；
- `docs/adr/` 不在包内：那些文件由技能生成，不会带手写 frontmatter，所以刻意排除；要读决策就按上面的路径去仓库里读。

## 四个后端怎么续接

每个 Run 一个一次性子进程，kind 决定用什么参数、怎么续上下文（参数细节见 [Agent Backend](../execution/agent-backend.md)）：

| kind | 原生配置读取 | session 续接 |
|---|---|---|
| `oma` | cwd 的 `AGENTS.md` / `SOUL.md` / `USER.md` 与 `.oma/skills` | 自己的 session 文件，引用经 `cliSessionRef` 传入传出 |
| `claude_code` | cwd 项目配置，MCP 经 `--mcp-config` | `--resume <sessionId>` |
| `pi` | cwd 项目配置，MCP 经 `pi-mcp-adapter` 扩展 | `--session <ref>` |
| `omp` | cwd 的 `.mcp.json` | `-r <ref>` |

- session 不按 kind 分目录、不共享。产品只存一个不透明引用（context branch 上的 `cli_session_ref`），输入时透传、outcome 回写；切 kind 等于换一个新 session。
- 分支还没有 session 引用时，首轮上下文由产品侧拍成 flat text 塞进输入消息（见 [Agent Backend](../execution/agent-backend.md)）。
- 只有 READY 状态的 pack 与恒有的 builtin 技能目录会进 Run 的 `skillRoots`，在 Run 创建时冻结。

## 一个对话一个 Agent

- 一个 conversation 对应一个 Agent，human 消息是外部事件（[ADR 0021](../../adr/0021-one-conversation-one-agent-member.md)）。
- 同一个 Agent 同时只能有一个活 Run；多个 conversation 各自一条执行线。
- 换 kind：在同一条分支上 fork 出新的，session 换新，上下文靠首轮文本桥接。

## Agent 造 Agent 的两条路

agent-config MCP server 绑在 loopback 上，只暴露三个工具：

- `agent_read { agentId }` — 读某个 Agent 的配置对象。
- `agent_create { name, model, backendKind?, reasoningEffort?, permissionMode? }` — 真创建，走 agent service（与 `POST /api/agents` 同一条路：物化工作区、写 `agent.yml`、插行、跑 onCreate）。参数刻意比 HTTP 少：不收 `id`，也不收 `workspacePath` / `mcpServers` / `knowledgePacks`（这些都要模型验证不了的 id）。防跑飞用进程内预算：10 分钟 5 次。
- `agent_write { agentId, config }` — **不写任何文件**，只把草案推给编辑页的 SSE 通道，表单采纳成未保存的编辑，用户点 Save 才提交。`agentId` 传保留值 `new`（`AGENT_DRAFT_ID`）时推给创建页的表单，用户点 Create 才落库。

不要试图用文件写来创建 Agent：目标目录在沙箱之外，而且只有目录没有 DB 行的"幽灵 Agent"对 list/getById 不存在。`agent_write` 对不存在的 agentId 直接报错，避免模型转述一个假成功。

## 不变量

1. Agent 的配置事实在 DB 的 `config` 列，工作区文件是它的导出与消费面。
2. `agent.yml` 只写不读；任何"改文件即改配置"的假设都不成立。
3. bridge 是工作区 `.mcp.json` 与 `.oma/product-tools.json` 的唯一作者，且可以任意次重跑。
4. 凭证只经 spawn env 进子进程；写进工作区文件的永远只有变量名。
5. 工作区路径必须在允许根内，创建与更新走同一条检查。
6. 一个 conversation 一个 Agent，一个 Agent 一个活 Run。

## 已知缺口

- `agent.yml` 的"文件为准"读回没有实现，今天这同时是一层保护：Agent 用自己的 write 工具改它不会生效。一旦真做读回，那条路径就变成自提权（改自己的模型、权限、MCP），必须同时加校验与桥接守卫。
- 已分配但状态不是 READY 的 pack 不建软链也不进 `skillRoots`，页面上看不出这个差别。
- `knowledge/index.md` 是 bridge 生成物，手改会被下一次 reconcile 覆盖。

## 相关页

- [Agent Backend](../execution/agent-backend.md) — 契约与四个 adapter
- [Agent Context](./context.md) — 单个 Agent 的语义历史
- [技能包管理](../plugins/skill-pack.md) — pack 怎么装、怎么分配
- [Project 与 Worktree](./projects-and-worktrees.md) — `projects/<id>` 从哪来
