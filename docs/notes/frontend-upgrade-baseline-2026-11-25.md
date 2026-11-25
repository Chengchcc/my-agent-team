# 前端升级基线（2026-11-25）

把交互原型落到现有 Web 之前，先把「原型要什么、代码有什么、差在哪」逐页写清。这份笔记是文件级的任务底账：每一页原型的代码落点、计划里每条接口说法的核对结论、管理工具的授权事实，以及还没解决的阻塞项。决策见 ADR 0081。

- 原型与计划：`/root/mat-independent-audit-20261124/`（`frontend-upgrade-plan.md`、`prototype-ui/index.html`）。
- 计划的取证基线是 `5f451e75`；本底账对照的是 `d99c5dae`，两者相差 20 个提交。
- 标「走读」的结论来自只读代码核对，标「真机」的在隔离栈上跑过。

## 基线之后已经有的，不要再做一遍

| 能力 | 落点 | 说明 |
|---|---|---|
| 状态词汇统一 | `apps/web/src/lib/status.ts` | 执行状态与连接状态各是一根轴，同一个词全站同义 |
| AHP 队列深度诊断 | `apps/web/src/lib/ahp.ts` | 帧队列高水位可在页面读取 |
| 可取消的轮询 | Today、System 各查询 | 离开页面即取消 |
| 运行期间配置变更留痕 | `agent_run` 的配置修订 | 运行冻结一份配置修订，steer 对分支做 CAS |
| 中文界面 | `apps/web/src/lib/locales/zh.ts` | 英文是源，缺键回退英文（ADR 0079） |

## 原型页面在现有代码里的落点

路由前缀省略 `apps/web/src/app/(main)/`。

| 原型页 | 路由 | 页面与主要组件 | 数据接口 | 离目标还差什么 |
|---|---|---|---|---|
| Today | `today/page.tsx` | AttentionInbox、RunBlockerCard、TasksSection | `/agent-runs`、`/pending-actions`、`/reminders`、`/telemetry/summary` | 按「需要你决定 / PA 处理中 / 未读结果」重排；来源按 PA、Bot、群组织 |
| PA 工作会话 | `chat/page.tsx`、`chat/[conversationId]/page.tsx` | ConversationCanvas → ConversationPanel、Timeline、Composer | `/conversations`、AHP WebSocket | 来源列表按 PA 与 Bot 分组；手工新建降为备用入口 |
| 需求事项 | `requirements/page.tsx`、`[requirementId]/page.tsx` | ProposalsView | `/requirements`（GET、PATCH）、`/proposals/pending` | 新建走 PA；参与 Agent 去重计数与关系图 |
| 工作流程 | `workflows/page.tsx`、`[workflowId]/**` | WorkflowList、AgenticWorkflowEditor、ExecutionTraceView | `/workflow-definitions`、`/workflow-executions` | 默认列表与只读概览；显式编辑才进画布 |
| 成果空间 | `artifacts/page.tsx` | ArtifactPreview、ArtifactPreviewSheet | `/artifacts` | 统一详情容器与来源链接 |
| Coding 工作台 | `coding/page.tsx` → `features/coding/` | CodingRail、TerminalPane | `/coding/terminals`、coding WebSocket | 只定位已有工作台，不无提示新建 PTY |
| 团队成员 | `team/page.tsx`、`team/[agentId]/**` | AgentForm、AgentDetail、AgentEditorLayout | `/agents`、`/harnesses`、`/models` | 按 PA 与 Worker 分区；新增与编辑用表单加 PA |
| Projects | `team/projects/page.tsx`、`[id]/page.tsx` | ProjectForm、ProjectList、ProjectDetailSheet | `/projects`、`/projects/:id/worktrees` | 已迁移为宽侧栏加 PA 会话（开关控制） |
| Wiki | `wiki/page.tsx`、`wiki/page/page.tsx` | WikiGraph、Markdown | `/wiki/pages|page|query|backlinks|graph|lint` | 阅读版式（16px 正文、有界行长、目录）；整理由 Workflow 驱动 |
| Skills | `team/skills/page.tsx` | SkillPackManager、PackFileViewer | `/skill-packs`、`/:id/skills`、`/:id/files` | 技能包到 Skill 到文件的只读树已具备；缺「未物化」的明确状态 |
| MCP | `team/mcp/page.tsx` | ResourceDetailSheet | `/mcp-servers`、`/:id/tools`、`/:id/tools/invoke` | 发现、连通、授权、调用分开呈现 |
| Observability | `system/page.tsx`、`system/runs/[runId]/page.tsx` | `components/ops/*` | `/ops/*`、`/agent-runs/:id/telemetry` | 统一详情容器 |
| Authority | `system/authority/page.tsx` | patterns | `/agent-runs`、`/proactive/events` | 只读账本的来源链展开 |
| Settings | `system/settings/page.tsx` | 各 SettingsSection | `/settings`、`/providers` | 常用与高级分层、Raw JSON 校验与差异 |
| Channels / Lark | 无独立路由：`team/[agentId]?tab=lark` | LarkSurfacePanel、AgentFormLarkSection | `/agents/:id/lark`、`/:id/lark/setup` | 见下文「Lark 渠道事实」，数据模型先要补 |

## 计划里的接口说法，对照当前代码

| 计划的说法 | 结论 | 证据 |
|---|---|---|
| slash 只有 6 条客户端命令 | 成立 | `apps/web/src/lib/slash-commands.ts`；未知的 `/x` 当普通消息发出 |
| `agent_create` 会真实创建 | 不准确：它只写提议，头注释是过期的 | `features/agent/agent-config-mcp.ts`；测试断言 `created` 为空 |
| Proposal 采纳不等于保存 | 不成立：`agent_config` 被编辑页轮询到后直接 `adopted`，后端随即写入；草稿目标（`new`）与 `workflow_definition` 采纳会失败，行永远 pending，前端吞掉错误 | `proposal/apply.ts`、`proposal/http.ts`、`features/agents/config-mcp.ts`、`AgenticWorkflowEditor.tsx` |
| Workflow 保存手动，提议靠轮询 | 成立 | 每 2 秒 `getPendingProposal`，脏表单或保存中跳过；按钮写着 ⌘S 但键盘没绑 |
| AHP 已有关闭守卫与每轮清理 | 成立；每轮清理没有测试锚点 | `apps/web/src/lib/ahp.ts`、`lib/ahp.test.ts` |
| Wiki HTTP 只读 | 成立；`revision` 是整文件哈希前 16 位，可当 CAS 令牌；没有历史与差异接口 | `features/wiki/http.ts`、`domain.ts` |
| 项目只能写 `name/repoUrl/defaultBranch` | 成立；真实工作区记录在 agent 与需求两侧 | `features/project/http.ts`、`project/worktree.ts`、`requirement-workspace.ts` |
| Coding 的 `?agent=` 会新建面板 | 成立；另外，首屏未加载时存在性判断为空，冷启动深链会多开一个；URL 同步会丢掉 `agent` 与 `project` | `features/coding/components/coding-page.tsx` |
| 需求没有 POST | 成立；创建入口是产品工具 `requirement_track` | `features/requirement/http.ts`、`product-tools/dispatch.ts` |

走读另见三处：`/chat` 有会话时只渲染骨架屏，导航里没有 `/chat` 链接；`useMcpCatalog` 有两份定义；`agent-config-mcp.ts` 的 `createAgent` 是从未被调用的依赖。

## 管理能力与授权事实

授权没有数据表，全是代码里的门：每个 run 冻结一份工具清单，身份取自 run 令牌，27 个工具预先同意，5 个仍受权限模式约束。权限模式里 `yolo` 全放行，`auto` 交分类器，`ask` 弹卡，`deny` 直接拒。

| 类别 | 工具 | 门 |
|---|---|---|
| 只读 | `project_list`、`project_detail`、`team_list`、`requirement_query`、`wiki_read/query/lint`、`history_*`、`reminder_list`、`artifact_download` | 预先同意 |
| 写提议（不落资源） | `agent_write`、`agent_create`、`workflow_write`、`project_propose` | 人在页面决定；这 5 个工具不在预同意名单 |
| 真实写入 | `requirement_track`、`project_attach`、`project_push`、`wiki_create/patch/source_add`、`dispatch`、`steer_worker`、`cancel_worker`、`remember`、`remind_me` | `dispatch` 的不可逆操作要求 `authorization === "user"`；`project_attach` 的「需要批准」只写在描述里，后端没有门 |
| HITL | `ask_question` | 挂起等人 |

`project_propose` 现在多一种用法：带 `project_id` 时提议修改已登记的项目，落到 `project_update` 类提议，与原有用法共用同一道门。

Skill 与 MCP 没有管理类产品工具。内置技能包里有 `project_manage`、`member_manage` 等管理 Skill，它们指导 PA 调用上表的工具。Skill 的 `hide` 与 `user_invocable` 标记在 HTTP 接口里不生效，接口返回包内全部 Skill。

## 其它已核实的缺口

- Skills：`/files` 不查包是否就绪，未物化只返回 404；不过滤点文件，git 包的 `.git/` 可被读取；无大小与二进制限制。
- MCP：tools/list 结果只在内存里，重启即丢；读取 inputSchema 与调用是两个端点但同一道登录门；调用无审批与审计。
- Settings：键值表，没有 schema，没有 revision，写入不校验版本。
- ADR 0079 之后源码仍须零 CJK（`audit:ui`），中文只能进 `lib/locales`。

## Lark 渠道事实

| 项 | 事实 |
|---|---|
| `lark-cli init` | 不存在。初始化是 `config init`；本机 `lark-cli` 包版本 1.0.96 |
| Bot 实体 | 没有独立实体。Lark 配置是每个 PA 内嵌的 `agents.config.lark`，profile 名与 systemd 单元名由 agentId 派生 |
| 唯一性 | 同一个飞书应用绑到两个 PA 没有任何校验 |
| 读模型 | 只有配置与心跳两类事实；「已部署」「进程运行」「连接建立」没有独立字段，「已绑定群」只在运行时接口里 |
| 运行 | 线上走 systemd 托管；代码改动后必须重启单元，`ensureLarkBot` 不会重启已在跑的机器人 |

原型的「Bot 账户列表 + 单选绑定一个现有 PA」在当前数据模型里没有对应物。这一批要先补可读 DTO 与唯一性校验，再开放写。

## 阻塞项

1. Lark 的多 Bot、多 PA 关系需要数据模型与唯一性校验，属于 Lark Attention 批次的前置。
2. `conversation.projectId` 与 ADR 0077 的需求工作区并存方式没有定：项目编辑不绑定整场会话，多项目主会话的后端契约待确认。
3. 事项级 scope 与新建事项的产品入口：HTTP 没有 POST，工具 `requirement_track` 已具备。
4. 项目、agent、MCP、Settings 的写入都没有版本冲突检测。
5. agent 与 workflow 编辑页的自动采纳要改掉，否则 D3「建议不等于保存」在这两处不成立。

## 批次与状态

没有灰度开关：控制台一次改到原型的设计，回滚靠整批 revert（ADR 0081）。

| 批次 | 状态 | 本批交付 |
|---|---|---|
| Baseline | 完成 | 本底账；品牌用户可见文本改为 oh-my-agent |
| Shared UI | 完成 | `ConversationPanel`、`ResourceEditorSheet`、`ProposalCard`；四档宽度与未保存保护 |
| 项目编辑样例 | 完成 | 宽侧栏加 PA 会话；`project_update` 提议与审阅值保存 |
| 整站基础 | 完成 | 主题与版式整站替换、导航分组、会话密度、共享 PA 会话（`PaSession`、`AskPaSheet`）、页面词典合并与一致性检查、Channels 页面 |
| 第一波页面 | 完成 | 成员（列表、详情、编辑）、需求（列表、目标页、建议收件箱）、Wiki（索引、阅读、问 PA）、可观测 |
| 第二波页面 | 完成 | Workflow（列表、只读概览、编辑器）、Coding、成果空间、Authority、Settings、Skills、MCP、Today、会话总览；真机验证结果见 ADR 0081 |
| 未做 | — | 运行详情页 `/system/runs/:id` |

### 两个波次里查出来、留给后端或产品的缺口

各页缺什么接口，记在 ADR 0081 的「没有解决的」里。其中影响最大的三条：流程列表没有批量读；同一目标只能读到最新一条挂着的建议；会话不记录来源是 Lark 私聊还是群。

## 复现验证环境

隔离栈不碰线上数据与端口：

```bash
# backend：独立数据目录，独立端口，oma 从 worktree 源码启动
cd apps/backend && BACKEND_DATA_DIR=/tmp/fe-stack/data BACKEND_PORT=3997 \
  BACKEND_HOST=127.0.0.1 BACKEND_AUTH_TOKEN=fe-token bun run src/main.ts
# web：worktree 里的 dev server，.env 指向上面的 backend
cd apps/web && node node_modules/next/dist/bin/next dev --port 3100 -H 127.0.0.1
```

这台机器只有 2 核 8G，而线上服务也跑在上面：dev server 编译时占到 4G 内存。同时只让两个人改代码，验证集中做一次；可用内存掉到 1G 以前先停掉 dev server。

两点环境事实：这台机器没有中文字体，截图前要装用户级字体；仓库根的 `bun run audit` 用的是 `scripts/audit-ui.ts`，`apps/web` 里同名的 `audit:ui` 是浏览器验收脚本，默认指向线上的 3001，不要在没有 `AUDIT_BASE` 时运行。
