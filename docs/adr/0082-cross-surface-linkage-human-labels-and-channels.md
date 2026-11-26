# ADR 0082: 跨工作面关联索引、全站名称优先展示与 Channels 新增 Lark 入口

- 状态: Accepted（2026-11-26 确认定稿，分三阶段实施中）
- 日期: 2026-11-26
- 相关: [设计哲学](../architecture/design-philosophy.md)、[ADR 0068](./0068-backend-supervises-the-bot.md)（后端托管 Lark 机器人）、[ADR 0073](./0073-a-terminal-in-the-agents-own-workspace.md)（工作区终端）、[ADR 0074](./0074-super-assistant-model.md)（超级助理与需求）、[ADR 0077](./0077-requirement-owns-the-workspace.md)（需求拥有工作区）、[ADR 0081](./0081-web-cutover-to-oma-design.md)（Web 切到 oh-my-agent 设计）

## 背景

控制台切到 oh-my-agent 设计（ADR 0081）后，真机体验暴露出三类紧耦合的产品断层，共同指向同一层架构缺口——**跨工作面的归属事实没有落成可查询索引，且展示层仍以底层主键为主**：

1. **五大工作面（需求 / 会话 / 产物 / Workflow / Coding）联动断裂，无法带筛选深链跳转**：
   - **产物（Artifact）没有 SQLite 索引表**：目前文件存磁盘、元信息靠 `.meta.json` sidecar（`apps/backend/src/features/artifact/adapter-fs.ts`），`source` 只记 `{ runId?, conversationId?, agentId? }`，缺少 `requirementId`、`workflowExecutionId`、`projectId`；`GET /api/artifacts` 只支持 `?folder=`，无法回答「这个需求 + 这个会话产出了哪些文件」。
   - **Workflow 执行缺归属外键**：`workflow_execution` 表只有 `workflowId`、`triggeredBy`、`input` 等执行字段，没有 `requirement_id`、`conversation_id`、`project_id`，无法反查某需求或某会话触发过哪些流程，也无法把流程产物串回需求。
   - **Coding 终端与会话/需求断链**：`TerminalInfo` 仅保存在进程内存与 JSON 快照（`apps/backend/src/features/coding/terminal-registry.ts`），只记录 `{ terminalId, projectId, agentId, cwd, title, kind }`，不记录 `conversationId`、`requirementId`、`workspaceId`；无法在 `/coding` 按会话或需求筛选终端，也无法从终端跳回来源会话或需求。
   - **已有关系未打通深链**：数据库已按 ADR 0077 建有 `conversation_requirement`（M:N）与 `conversation.current_requirement_id`，但 `/chat`、`/requirements`、`/workflows` 缺少统一的 URL 筛选参数与可读筛选条。
2. **全站多处直接暴露技术 ID**：
   - 后端读模型 DTO（如 `ArtifactMeta.source`、`agentRun`、`workflowExecution`、`TerminalInfo`）只返回外键 ID，各页面各自拼接 `useAgentList()` / `useProjectList()`，遗漏处便直接把 `default`、`conv-xxx`、`run_xxx`、`proj_xxx`、`req_xxx` 渲染为主链接文本（例如 `ArtifactDetail.tsx` 直接把 `source.conversationId` 作为可读名称展示）。
3. **`/channels`（Lark）缺少新增飞书机器人入口**：
   - 当前 `/channels` 只罗列已存在的 PA（`apps/web/src/app/(main)/channels/page.tsx`），没有新增/配对引导。用户想接入新的飞书机器人时必须绕道 `/team` 先建 PA，再跳转成员详情的 Lark 标签页。
4. **会话页右侧栏信息冗余，且会话 Markdown 未接通实体预览/跳转**：
   - 当前 `/chat/[conversationId]` 右侧栏同时摆了「来源与当前 PA」卡片和「成员（`RosterList`）」卡片（`apps/web/src/components/ConversationCanvas.tsx`）；在 1:1 会话模型下，同一位成员在页头、来源卡、成员卡重复出现 3 次，而真正该在侧栏沉淀的「本会话涉及的需求、产物、项目与终端」完全缺席（与原型 `lark-session-multi-project.png` 的「这里涉及的项目与事项」差距明显）。
   - 会话 Markdown（`apps/web/src/components/Markdown.tsx`）只识别裸 `artifacts://` 链接（且依赖全量拉取 `useArtifacts()` 查找），所有站内链接（`/requirements/...`、`/chat/...`、`/wiki/...`）都被统一渲染为 `target="_blank"` 外链，无法直接识别/展示需求名称或原地预览产物与需求。

按[设计哲学](../architecture/design-philosophy.md)的三条底线——**统一本体，不复制语义；暴露业务，隐藏机制；边界要硬，概念要少**——本 ADR 一次性给出最小熵的表结构扩展、读模型带名约定、URL 筛选契约与 Channels 入口设计。

## 决策

### D1 产物元数据迁入 SQLite 索引表 `artifact`（字节留磁盘，归属入库）

文件本体继续存储在磁盘目录（保持大文件与二进制流式读取零膨胀），新增 `artifact` 表作为列表、过滤与归属关系的单一查询真源：

```sql
CREATE TABLE artifact (
  url TEXT PRIMARY KEY,
  folder TEXT NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  encoding TEXT NOT NULL,            -- 'utf8' | 'base64'
  sha256 TEXT,
  run_id TEXT REFERENCES agent_run(run_id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversation(conversation_id) ON DELETE SET NULL,
  requirement_id TEXT REFERENCES requirement(requirement_id) ON DELETE SET NULL,
  workflow_execution_id TEXT REFERENCES workflow_execution(execution_id) ON DELETE SET NULL,
  agent_id TEXT,
  project_id TEXT REFERENCES project(project_id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_artifact_folder ON artifact(folder, updated_at DESC);
CREATE INDEX idx_artifact_requirement ON artifact(requirement_id, updated_at DESC);
CREATE INDEX idx_artifact_conversation ON artifact(conversation_id, updated_at DESC);
CREATE INDEX idx_artifact_execution ON artifact(workflow_execution_id, updated_at DESC);
CREATE INDEX idx_artifact_run ON artifact(run_id);
```

- **归属冻结规则（写入时计算，不事后猜测）**：
  1. 调用方显式传入的 `source.{ runId, conversationId, requirementId, workflowExecutionId, agentId, projectId }` 优先；
  2. 若未传 `requirementId`，后端按 `run_id → agent_run.requirement_id`、其次 `conversation_id → conversation.current_requirement_id`、其次 `workflow_execution_id → workflow_execution.requirement_id` 自动补齐；
  3. 若未传 `projectId`，按 `requirement.project_id` 或 `conversation.project_id` 补齐；
  4. 仍无归属时保持 `NULL`（例如用户在 `/artifacts` 手动上传的文件），前端如实显示「未记录」，绝不伪造归属。
- **双写与存量回填**：
  - `put()` 写盘成功后同步 upsert `artifact` 行（继续保留 `.meta.json` 兼容已有 `verify()` 与磁盘独立可读性）；`delete()` 同步删盘与删行。
  - 后端启动时执行一次幂等回填：扫描磁盘文件与 `.meta.json`，对不在 `artifact` 表中的文件补建索引行，并按已存 `runId / conversationId` 尽力回填 `requirement_id` 与 `project_id`。
- **查询 API**：`GET /api/artifacts` 扩展支持组合过滤参数：`folder`、`requirementId`、`conversationId`、`workflowExecutionId`、`agentId`、`projectId`。

### D2 `workflow_execution` 增补可空归属列

为 `workflow_execution` 表新增三个可空外键列与索引，不改变现有 `definition` / `store` / `status` 语义：

```sql
ALTER TABLE workflow_execution ADD COLUMN requirement_id TEXT REFERENCES requirement(requirement_id) ON DELETE SET NULL;
ALTER TABLE workflow_execution ADD COLUMN conversation_id TEXT REFERENCES conversation(conversation_id) ON DELETE SET NULL;
ALTER TABLE workflow_execution ADD COLUMN project_id TEXT REFERENCES project(project_id) ON DELETE SET NULL;

CREATE INDEX idx_workflow_execution_requirement ON workflow_execution(requirement_id, created_at DESC);
CREATE INDEX idx_workflow_execution_conversation ON workflow_execution(conversation_id, created_at DESC);
CREATE INDEX idx_workflow_execution_project ON workflow_execution(project_id, created_at DESC);
```

- `POST /api/workflow-executions` 接受可选的 `{ requirementId?, conversationId?, projectId? }`（手动/cron/webhook 无上下文触发时为 `NULL`）。
- Workflow 驱动 `agent` 节点发起 `agent_run` 以及节点产出上传 `artifact` 时，透传 `workflowExecutionId` 与继承到的 `requirementId / projectId`，把「需求 → 流程执行 → 节点运行 → 产物」整条链打通。
- `GET /api/workflow-executions` 支持按 `workflowId`、`requirementId`、`conversationId`、`projectId` 筛选。

### D3 Coding 终端元信息迁入 SQLite 表 `coding_terminal`

替换当前脆弱的 `terminals.json` 快照文件（`apps/backend/src/features/coding/persist.ts`），用 SQLite 表保存 Coding 终端的归属与重启恢复布局：

```sql
CREATE TABLE coding_terminal (
  terminal_id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES project(project_id) ON DELETE SET NULL,
  agent_id TEXT NOT NULL,
  workspace_id TEXT REFERENCES workspace(workspace_id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversation(conversation_id) ON DELETE SET NULL,
  requirement_id TEXT REFERENCES requirement(requirement_id) ON DELETE SET NULL,
  cwd TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'shell',   -- 'shell' | 'oma'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_coding_terminal_conversation ON coding_terminal(conversation_id);
CREATE INDEX idx_coding_terminal_requirement ON coding_terminal(requirement_id);
CREATE INDEX idx_coding_terminal_project ON coding_terminal(project_id);
CREATE INDEX idx_coding_terminal_agent ON coding_terminal(agent_id);
```

- **本体不变**：PTY 进程本身仍由后端进程托管（ADR 0073），`coding_terminal` 只持久化布局、归属与恢复所需的元信息（不含敏感环境变量），启动恢复逻辑从读 JSON 改为读此表；若启动时存在旧 `terminals.json` 且表为空，做一次性兼容导入后不再写旧文件。
- **打开与反向联动**：
  - `POST /api/coding/terminals` 接受可选 `{ conversationId?, requirementId?, workspaceId? }`，缺省从 `conversation.current_requirement_id` 推导 `requirementId`。
  - 会话顶栏「终端」入口改为 `/coding?locate=1&conversation=<cid>&agent=<aid>[&requirement=<rid>][&project=<pid>]`。
  - 需求详情页「在工作台打开」入口指向 `/coding?locate=1&requirement=<rid>[&project=<pid>]`。
  - Coding 终端页头展示该终端关联的「会话名称 / 需求标题 / 项目名」，点击可直接跳回对应会话或需求。
- **不变量延续（ADR 0081）**：带 `locate=1` 进入 `/coding` 只做筛选定位与展示已有终端，绝不在页面加载时自动创建新 PTY；无匹配终端时给出带预设归属的显式「新建终端」按钮。

### D4 五大工作面统一 URL 深链筛选契约

所有跨页跳转统一使用同一组 query 参数名（语义与前端路由一致，不混用 `cid / reqId / conv` 等缩写）：

| 目标页面 | 支持的筛选参数 | 典型来源入口 |
|---|---|---|
| `/artifacts` | `requirement`、`conversation`、`execution`、`project`、`agent`、`folder`、`kind` | 需求详情「查看产物」、会话顶栏「产物」、流程执行详情「本次运行产物」 |
| `/chat` | `requirement`、`project`、`agent` | 需求详情「关联会话」、项目详情「相关会话」、成员详情「会话」 |
| `/workflows` | `requirement`、`project` | 需求详情「关联流程执行」、项目详情 |
| `/workflows/[workflowId]` | `tab=executions` + `requirement`、`conversation` | 需求详情、会话内触发回执 |
| `/coding` | `locate=1` + `conversation`、`requirement`、`project`、`agent` | 会话顶栏「打开终端」、需求详情「工作区」、项目 Worktree 卡片 |
| `/requirements` | `project`、`conversation`、`status` | 项目详情「相关需求」、会话内需求标签 |

- **统一的激活筛选条（Active Filter Bar）**：只要 URL 带有上述任一实体筛选参数，目标页顶部必须渲染人类可读的筛选芯片（例如 `需求：重构登录流 ×`、`会话：与 Personal Agent 的会话 ×`），支持单条清除或全部清除，且刷新/分享链接保持同一筛选态。
- **不丢失上下文**：筛选条件同步到 URL query（`router.replace`），用户点开详情抽屉或刷新页面后筛选不丢。

### D5 全站名称优先展示（读模型带名 + `<EntityLink />` 原语）

去 ID 化不能靠前端每个页面手写 `Map` 兜底，分两层彻底收口：

1. **后端读模型边界附带展示名（`labels`）**：
   - 在列表/详情查询的 SQLite adapter 或读投影层，通过 `LEFT JOIN` / 批量 `IN` 查询为每条返回记录附带可选的轻量可读名对象（不改变已有 ID 字段，完全向后兼容）：
     - `ArtifactMeta` 增加 `labels?: { agentName?; conversationTitle?; requirementTitle?; projectName?; workflowName? }`，并扩展 `source` 包含 `requirementId? / workflowExecutionId? / projectId?`；
     - `TerminalInfo`（HTTP DTO）增加 `conversationId / requirementId / workspaceId` 与 `labels?: { agentName?; projectName?; conversationTitle?; requirementTitle? }`；
     - `WorkflowExecution` 列表/详情 DTO 增加 `requirementId / conversationId / projectId` 与 `labels?: { workflowName?; requirementTitle?; conversationTitle?; projectName? }`；
     - `AgentRun` 列表/详情 DTO 附带 `labels?: { agentName?; conversationTitle?; requirementTitle? }`；
     - `Conversation` 列表/详情 DTO 附带 `labels?: { agentName?; projectName?; currentRequirementTitle? }`。
2. **前端统一 `<EntityLink />` 展示原语与名称回退规则**：
   - 新增共享组件 `apps/web/src/components/ui/entity-link.tsx`：接收 `kind`（`agent | conversation | requirement | project | workflow | run | execution`）、`id`、`label`、`href` 与 `showSecondaryId?`。
   - **视觉层级纪律**：主文案永远显示 `label`；无 `label` 时使用统一可读回退（例如无标题会话显示「与 {成员名} 的会话」或按日期生成的短标题，而非 `conv-8f3a91...`）；技术 ID 仅在 `title` tooltip 或详情折叠面板的等宽次要栏位展示（`font-mono text-[10px] text-(--faint)`），且附带复制能力。
   - **明确豁免区域**：原始 JSON / DSL 查看器、运行详情排障日志、URL 地址栏与错误堆栈保留完整技术 ID。

### D6 `/channels` 新增 Lark 机器人向导（守住 ADR 0068，零新表）

维持 **1 PA = 1 Lark Bot** 的单一本体，不新增 `lark_channel` 表，不改动 `my-agent-team-lark-bot@<agentId>.service` 模板与 `agent.lark.enabled` 单一控制面（ADR 0068）：

- `/channels` 页头新增主操作按钮「新增飞书机器人」（`Add Lark bot`），打开引导 Sheet，提供两条清晰路径：
  1. **绑定到已有 PA**（当存在 `role !== "worker"` 且尚未配置 Lark App 的 PA 时默认优先展示）：下拉选择目标 PA（显示 PA 名称与头像）→ 就地复用现有 `LarkSurfacePanel` / `useLarkSetup` 发起扫码或填写凭证完成配对。
  2. **新建 PA 并绑定飞书机器人**：表单收集最小必要字段（PA 名称、机器人显示名、可选模型/能力描述）→ 调用既有 `POST /api/agents` 创建 PA → 立即在同一步进入该 PA 的飞书授权流程，完成后列表自动刷新显示新行。
- 复用单一向导状态机（`lark_setup_session`），不在 `/channels` 复制第二套配对逻辑。

### D7 重做会话右侧栏：移除冗余「成员」卡片，升级为「本会话上下文」栏

1:1 会话模型（一个会话一个成员，Worker 执行在独立子会话中）决定了「成员列表卡片」已经没有存在意义：成员身份在会话页头展示一次（点击可进 `/team/<id>`）即可。右侧栏（支持桌面端折叠收起，移动端抽屉打开）重构为面向工作的 **Session Context**，全部由真实关联数据驱动：

1. **当前与关联需求（Requirements）**：列出本会话 `conversation_requirement` 关联的需求，高亮 `current_requirement_id`，展示需求标题、派生状态与所属项目名；点击进入需求详情，底部链接直达 `/requirements?conversation=<cid>`。
2. **本会话产物（Artifacts）**：通过 `GET /api/artifacts?conversationId=<cid>` 展示本会话产出的最近产物（文件名 + 类型/大小 + 产出成员名）；点击就地弹出 `ArtifactPreviewSheet` 预览，底部链接直达 `/artifacts?conversation=<cid>`。
3. **关联项目、工作台终端与流程（Projects · Coding · Workflows）**：展示本会话关联的项目、活跃 Coding 终端（直达 `/coding?locate=1&conversation=<cid>`）与由此会话触发的流程执行（直达执行详情）。
4. **折叠的「会话详情与诊断」**：将 `UsagePanel`、`RunDiagnostics`、当前 PA 的模型/harness 配置以及只读 `conversationId` 收纳进底部默认折叠的 `<details>`，排障时一键展开，日常阅读不占主视觉。

### D8 会话 Markdown 实体内联预览与会话样式向原型靠拢

1. **会话 Markdown 识别并增强站内实体引用**（升级 `apps/web/src/components/Markdown.tsx` 与 `remark-artifact-url.ts`）：
   - **产物（`artifacts://...`）**：保留卡片渲染并支持按需读取单条元信息（不再强制每次全量扫 `useArtifacts()`），点击直接弹出 `ArtifactPreviewSheet` 预览，同时提供「在成果空间打开」深链；未命中索引时仍保持可点击预览/下载而非死外链。
   - **需求（`/requirements/<id>` 链接及标准需求引用）**：渲染为带真实需求标题与派生状态的内联实体芯片/小卡片（不把裸 `req_xxx` 当主文案），支持点击快速预览摘要或站内跳转 `/requirements/<id>`。
   - **站内链接路由收敛**：所有以 `/` 开头的控制台内部链接（`/chat/...`、`/wiki/page?...`、`/workflows/...`、`/coding?...`、`/artifacts?...`）统一使用 Next.js `<Link>` 站内跳转，不再误加 `target="_blank"`；仅真实外部 `http(s)://` 链接新开标签页。
2. **会话样式向原型（`lark-session-multi-project.png`）靠拢**：
   - 顶部增加「← 所有工作会话」返回条与来源标识（Web / Lark 私聊 / 群），页头信息紧凑化、不再在正上方重复堆砌成员信息；
   - 优化消息流排版与阅读节奏（清晰的轮次间距、无边框柔和正文、用户消息薄荷/中性气泡层次、派发子会话摘要条），以及更贴近原型的 Composer 底部输入卡片（内嵌模型/Skill 提示与薄荷色圆形发送按钮）。

## 数据库变更汇总（Migration 0071）

| 变更对象 | 类型 | 说明 |
|---|---|---|
| `artifact` | 新表（+5 索引） | 产物元数据与跨实体归属索引；文件 bytes 仍在磁盘 |
| `coding_terminal` | 新表（+4 索引） | Coding 终端元信息、归属与重启恢复记录；取代 `terminals.json` |
| `workflow_execution` | 加 3 列（+3 索引） | `requirement_id`、`conversation_id`、`project_id`（均可空） |

> 迁移落地时需同步更新 `AGENTS.md` 中的 schema 表计数（`30 tables` → `32 tables`），保证 `bun run audit:docs` 通过；全部新列均允许 `NULL`，升级对既有数据库零破坏。

## 不变量

1. **单一开关不分裂**：Lark 机器人启停与绑定仍以 `agent.lark` 为唯一真源（ADR 0068），`/channels` 新增入口只是创建/配置 PA 的快捷工作流，不造独立 channel 实体。
2. **归属不伪造**：`artifact`、`workflow_execution`、`coding_terminal` 的所有归属外键均可空；历史数据或手动操作没有归属时保持 `NULL`，UI 诚实显示「未记录」。
3. **产物字节与索引一致**：产物上传与删除在 `ArtifactService` 层原子维护磁盘与 `artifact` 表；磁盘文件缺失时 `download/verify` 仍以实际文件为准，不隐瞒损坏。
4. **定位不隐式创建**：`/coding?locate=1&...` 只筛选并聚焦已有终端，永不在导航加载时偷偷 spawn PTY（延续 ADR 0081）。
5. **名称优先，ID 可查不抢眼**：所有业务卡片、筛选芯片、侧栏关联项主文案必须为人类可读名称；技术 ID 退居次要等宽信息或排障折叠区。
6. **过滤状态可复现**：五大工作面的跨页联动筛选必须编码在 URL query 中，刷新或复制链接得到相同结果。
7. **词典零冲突与零源码中文**：新增界面文案遵循 ADR 0079，`apps/web/src/` 下除 `lib/locales/` 外零中文，且通过 `lib/locales/pages/index.test.ts` 与 `audit:ui`。

## 分阶段实施计划与验收标准

### 阶段一：数据库迁移与后端关联读模型（Migration 0071 + Backend）
- 生成并执行 Drizzle 迁移 `0071`（`artifact`、`coding_terminal`、`workflow_execution` 扩展）并更新 `AGENTS.md` 表计数。
- 实现 `artifact` SQLite 索引适配器 + 启动期磁盘回填 + 写入归属冻结 + `GET /api/artifacts` 多维过滤与 `labels` 输出。
- 实现 `workflow_execution` 归属透传（运行启动、节点 agent run、产物上传）与查询过滤 + `labels` 输出。
- 实现 `coding_terminal` SQLite 持久化（替代 `terminals.json`，含一次性旧文件导入）+ 归属字段 + `labels` 输出。
- 为 `conversation` / `agent_run` 读模型补齐缺失展示名字段。
- **验收**：后端单测覆盖回填、归属继承、多维组合过滤、删除级联 `SET NULL` 与旧 `terminals.json` 导入；`typecheck` + `bun run audit` 全绿。

### 阶段二：五大工作面深链筛选 + `/channels` 新增 Lark 入口 + 会话上下文侧栏与 Markdown 增强
- 新增共享 `<ActiveFilterBar />` 与 `<EntityLink />` 组件。
- 打通 `/artifacts`、`/chat`、`/workflows`、`/workflows/[id]`、`/coding`、`/requirements` 之间的双向带参深链与可读筛选条。
- 在 `/channels` 实现「新增飞书机器人」引导抽屉（绑定未配对已有 PA / 一步新建 PA 并完成配对）。
- 重构 `/chat/[conversationId]` 右侧栏（移除重复成员卡，替换为需求 / 产物 / 终端与流程上下文 + 折叠诊断区，支持收起）与会话头部/Composer 样式对齐原型；升级会话 `Markdown` 支持需求与产物的内联名称展示、就地预览及站内无刷新跳转。
- **验收**：从任意需求 → 产物 / 会话 / 流程 / Coding 跳转均可精准过滤并展示可读名称芯片；在 `/channels` 可不离开页面完成新 PA 建档并进入飞书授权；会话右侧栏无重复成员卡，Markdown 中的产物/需求引用可直接预览或站内跳转。

### 阶段三：全站去 ID 化收口与真机验收
- 系统排查并替换剩余暴露裸 ID 的前端视图（产物侧栏、运行详情、权限账本、工作流执行列表、需求详情、Coding 终端头、会话卡片与子会话链接）。
- 更新中文词典并通过 `audit:ui`、`pages/index.test.ts`、全量单测与无头浏览器真机逐页巡检。

## 明确不做（本 ADR 范围之外）

- 不支持「单 PA 绑定多个飞书机器人」或机器人跨 PA 换绑（若未来确有此需求，单独出 ADR 修订 ADR 0068）。
- 不为产物引入版本历史或审核验收状态机（产物仍是单地址覆盖写模型，保持 ADR 0081 诚实表述）。
- 不改写 ADR 0077 中 `workspace` 的依赖安装与清理策略。
