# Oma Tools

一句话：本页是 oma 原生工具表的权威描述。工具表在 Run 装配时确定：原生工具加已挂载的 MCP 工具加插件工具，原生名字冲突时原生胜；`--tools` 在**最终**表上做白名单或黑名单过滤，被滤掉的工具模型根本看不到。

## 范围

覆盖：工具名与类别、哪些工具只在独立 CLI 挂载、权限门三态的适用范围、MCP 挂载与门禁、context 文件注入、记忆的读写面、超时与预算旋钮。

不覆盖：插件机制与信任（见 [Oma 插件与 HITL](../plugins/oma-plugins.md)）、compaction（见 [Compaction](./compaction.md)）、产品侧 MCP server 的配置（见 [Agent 工作区与多后端](../agents/workspace-and-backends.md)）、模型与凭证（见 [模型与 Provider](./models.md)）。

## 实现文件

- `apps/oh-my-agent/src/core/runtime/run-runtime.ts` — `buildNativeToolStage`（文件 / 目录 / 执行 / 网络工具、MCP 挂载、超时包装）、条件注入（ask / todo / learn / manage_skill / recall / retain）、最终过滤
- `apps/oh-my-agent/src/core/tools/*` — 各原生工具的实现
- `apps/oh-my-agent/src/core/memory/*` — `learn`、`manage_skill`、`recall`、`retain` 与向量库
- `apps/oh-my-agent/src/core/delegation/*`、`core/orchestrate/tool.ts`、`core/coordination/*` — `task`、`workflow_run`、`hub`、`yield`
- `apps/oh-my-agent/src/core/runtime/tool-filter.ts` — `--tools` 语法
- `apps/oh-my-agent/src/core/settings/workspace-context.ts` — context 文件链
- `apps/oh-my-agent/src/core/settings/project-settings.ts` — `.oma/settings.json` 旋钮

## 工具表

"只在独立 CLI"一列指该工具只在 print / json / tui 三种模式挂载，产品走的 rpc 模式没有它。

| 工具 | 类别 | 作用 | read_only | 只在独立 CLI |
|---|---|---|---|---|
| `read` | 文件 | 读文本文件，`path:N-M` 行选择器 | 有 | 否 |
| `read_image` | 文件 | 读 png/jpeg/gif/webp 成 vision block（magic byte 嗅探，5MB 上限） | 有 | 否 |
| `ls` / `tree` | 文件 | 目录视图：ls 是扁平的、按 mtime 排，tree 递归 | 有 | 否 |
| `glob` / `grep` | 文件 | 模式搜索 | 有 | 否 |
| `write` / `edit` | 文件 | 写与行锚点编辑；路径沙箱外即拒。**写新鲜度门禁**默认开：`read` 在结果末尾回一行整文件指纹，`edit` / `write` 改已有内容必须回传同一个值，否则拒（拒绝信息里不含当前指纹）。`editFreshness: "off"` 只在独立 CLI 生效，rpc Run 保持默认 | 无 | 否 |
| `bash` | 执行 | shell；后台任务注册表；可选的 OS 沙箱 | 无 | 否 |
| `eval` | 执行 | TS/JS 片段，走子进程沙箱 | 无 | 否 |
| `browser` | 执行 | headless Chromium：`open` / `close` / `run`，截图存 `.oma/screenshots` | 无 | 否 |
| `web_search` / `web_fetch` | 网络 | 搜索与带守卫的抓取（`disableWeb` 可关） | 有 | 否 |
| `skill_load` | 技能 | 按名字取某个技能的正文（索引在 Meta 里） | 有 | 否 |
| `todo_write` / `todo_read` | 任务 | 会话任务列表；只在没有别的来源提供 `todo_write` 时挂载 | 写为无 | 否 |
| `ask_question` | 交互 | 问人一个问题；只在没有注入版本时挂载 | 有 | 否（但 rpc 无人可问，见下） |
| `task` | 委派 | 起子代理（叶子隔离，工具面按 access 裁剪） | 按 access | 否 |
| `workflow_run` | 委派 | 跑 vm 沙箱里的 workflow 脚本，内部可 `agent()` | 按 access | 否 |
| `hub` | 委派 | 协调子代理与后台作业 | — | 否 |
| `yield` | 委派 | 带 schema 的子代理返回通道 | — | 否（只挂在子代理表里） |
| `learn` | 记忆 | 记一条教训：`learned.md` 双写向量索引，可顺带铸造一个技能 | 无 | **是** |
| `manage_skill` | 记忆 | 增删改受管技能并即时刷新索引 | 无 | **是** |
| `recall` | 记忆 | 混合检索记忆库（向量加 FTS 融合） | 无 | **是** |
| `retain` | 记忆 | 只写索引，不写文件 | 无 | **是** |
| `mcp__<server>__<tool>` | 挂载 | 工作区 `.mcp.json` 与插件 `.mcp.json` 提供的工具 | 有 | 否 |

`learn` / `manage_skill` / `recall` / `retain` 只在**独立 CLI 且工作区可写**时挂载。rpc 模式下 `learn` 会直接报 "Unknown tool: learn"，这是刻意的：产品路径的记忆语义归 Product Backend，工作区文件不该能改产品的记忆。

`ask_question` 另有一条注入优先规则：产品会给 rpc Run 挂一个自己的 `ask_question`（走产品工具），那时原生工具不挂。独立 TUI 有问询面板；print / json 没有 handler，原生工具会 fail-closed 返回错误，不会假装问过。

`browser` 在 read_only 不挂载：它会写截图到工作区，还会驱动真实的浏览器会话。`ls` 与 `tree` 是只读目录视图，read_only 也有。

## 权限门三态

`permissionMode` 决定工具调用要不要先过关，三态语义不同：

| 模式 | 行为 |
|---|---|
| `ask` | 高风险工具（`bash` / `browser` / `eval` / `write` / `edit` / `learn` / `manage_skill` / `mcp__*`）逐调用发审批卡，超时等于 deny；没有审批管道时直接 block（fail-closed） |
| `auto` | 越过工作区沙箱的工具（`bash` / `browser` / `eval` / `manage_skill` / 带 skill 参数的 `learn` / `mcp__*` / 插件工具）逐调用过分类器；`write` / `edit` 不过分类器（路径沙箱已经约束了它们） |
| `deny` | 同上那批高风险工具直接 block，插件代码组件整体不挂载 |
| `yolo` | 门整体关掉（不过分类器、不发卡）；作为补偿，存在平台工具时强制打开 OS bash 沙箱。工作区包含、受保护文件、密钥剥离、出口规则、写新鲜度这些静态边界仍然生效，它们不在这个门里 |
| 缺省 | 不过门（独立 CLI 的历史默认） |

两个细节：

- 硬熔断在任何审批之前，且不可覆盖：`bash` 命令指向根、顶层目录、home 或裸变量 glob 的删除一律拦下，分类器和人工审批都压不过它。
- `auto` 下分类器判 block 会**升级给人一次**（同一个动作只发一张卡），重复同一动作静默 deny。

产品自己的读接口走**显式同意白名单**（`consentedMcpTools`），不按 server 名前缀豁免：白名单里的 `mcp__product-tools__history_*`、`mcp__knowledge__*`、`mcp__product-tools__todo_write`、`ask_question` 等免于分类器与审批。前缀规则会让产品 server 以后新增的任何工具自动免检，所以不用前缀。白名单外的 `mcp__*` 一律过门。

## MCP 挂载

- 来源两处：工作区根 `.mcp.json`（bridge 写的，含产品工具）与已安装插件的 `.mcp.json`。名字冲突时**工作区优先**，插件之间按 resolver 顺序。
- 工具注册名统一是 `mcp__<server>__<tool>`；原生表里已有同名（或裸名）时跳过。
- stdio server 的 command 在 spawn 前校验（绝对路径、PATH 查找、可执行位）；坏命令只让**它自己**那个 server 报错，不会让整个 Run 挂掉。
- 单次调用有超时（见下），连接与 `tools/list` 共用同一个上限。
- 插件 `.mcp.json` 里的 `${CLAUDE_PLUGIN_ROOT}` 与 `${CLAUDE_PROJECT_DIR}` 会被替换，并作为同名 env 导出给 server 进程。

## Context 文件注入

这部分不在工具表里，由系统提示承担（system role，天然粘性）：

- `SOUL.md` 与 `USER.md`（cwd），平文在前。
- `<repo-rules>`：`AGENTS.md` 链，从包含 `.git` 的仓库根（含）到 cwd，远的在前、cwd 最显著；没有仓库根时到 home 为止；最后追加用户级 `~/.oma/AGENTS.md`；内容逐字相同的副本折叠，保留更显著的那份。只认 `AGENTS.md`。
- `<available_knowledge>`：`knowledge/index.md`。
- `<dir-context>`：cwd 下一层里**没有**加载的 `AGENTS.md`，只给指针，改那个目录前先读。

## 记忆

两套东西并存：

- 文件层：`.oma/memory/learned.md` 是真源，由 `learn` 追加。
- 向量层：`.oma/memory/memory.db`（bun:sqlite 加 FTS5）。写入路径有 `learn` 双写、自动管线入库、`retain` 显式写、以及首次打开时对 `learned.md` 的一次性回填；读取路径是 `recall` 的混合检索。默认 embedding 模型是 `intfloat/multilingual-e5-small`（384 维 int8），缓存在 `<agentDir>/models`，可用 `OMA_EMBEDDING_CACHE` 迁移；模型拿不到时 FTS 声部照常应答并标 DEGRADED；`OMA_EMBEDDINGS=off` 硬关，`OMA_VECTOR_MEMORY=0` 关掉整个向量层。

## 超时与预算

| 旋钮 | 默认 | 说明 |
|---|---|---|
| 单次模型调用 | 300s | provider 卡住时 Run 失败，不自动重试（env `OMA_MODEL_TIMEOUT_MS`） |
| MCP 单次调用 | 120s | `maxToolTimeoutMs` 是全局上限（env `OMA_MCP_TIMEOUT_MS`） |
| 原生工具包装 | 30s | bash 与 eval 自己有更细的死线，包装层按各自上限兜底 |
| 审批等待 | 120s | 超时等于 deny（env `OMA_APPROVAL_TIMEOUT_MS`） |
| 分类器 | 30s | env `OMA_CLASSIFIER_TIMEOUT_MS` |
| `maxSteps` | 500 | 防失控的步数上限（env `OMA_MAX_STEPS`） |
| `--tools` | — | 纯名字是白名单，`!name` 是黑名单；同时约束主会话与子代理表 |

## 不变量

1. 工具表 per-Run 冻结；`--tools` 同时约束主会话与子代理，模型看不到被滤掉的工具。
2. read_only 的工作区没有 `write` / `edit` / `bash` / `eval` / `browser`。
3. effect-escaping 的工具必须过权限门；`write` / `edit` 在 `auto` 下免审靠的是路径沙箱，不是信任。
4. 产品工具的免检靠显式白名单，不靠 server 名前缀。
5. MCP 命令在 spawn 前校验，一个坏 server 不影响其他 server 与 Run。
6. 独立的向量记忆与本地记忆只在独立 CLI 挂载，产品 Run 不挂。

## 已知缺口

- `ask_question` 在 print / json 与 rpc 三种非交互模式下都无人应答：原生工具会 fail-closed，产品路径要靠注入版才可问。
- 记忆只在独立 CLI 可用，产品 Run 里的 Agent 无法记住任何东西。
- `manage_skill` 写的技能落在 `<agentDir>/managed-skills`，在工作区沙箱之外，所以在 `ask` 模式下它是要审批的高风险工具。

## 相关页

- [Oma Runtime](./oma.md) — 装配与 per-Run 状态
- [模型与 Provider](./models.md) — 模型超时之外的 provider 侧事实
- [Oma 插件与 HITL](../plugins/oma-plugins.md) — 审批链、分类器、信任
- [渐进式技能](../plugins/progressive-skill.md) — `skill_load` 与索引
