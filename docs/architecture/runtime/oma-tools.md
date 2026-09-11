---
id: runtime.oma-tools
title: Oma Tools
status: current
owners: architecture
summary: "oma 原生工具表全览：文件类（read/read_image/ls/tree/glob/grep/write/edit）、执行类（bash/eval/browser）、网络类（web_search/web_fetch）、会话类（skill_load/todo/ask_question）、委派类（task/workflow_run/hub），外加 MCP 挂载。每类标注 timeout、权限门禁（ask/auto/deny）、workspaceAccess（read_only）与 --tools 过滤的行为。"
depends_on:
  - runtime.oma
used_by:
  - agents.context
---

# Oma Tools

工具表在 Run 装配时确定（`apps/oh-my-agent/src/core/runtime/run-runtime.ts`）：native 工具 + 已信任的 MCP 工具 + 插件工具合并，native 名字冲突时 native 胜。`--tools` 过滤（`toolFilter`）作用于**最终**工具表——白名单（`--tools read,grep` 只留这些）或黑名单（`--tools '!bash'` 去掉这些），同样约束委派给子代理的工具表。

## 工具总览

| 工具 | 类别 | 作用 | read_only | 权限门禁（ask/auto） |
|---|---|---|---|---|
| `read` | 文件 | 读文本文件（`path:N-M` 行选择器，结构化摘要） | ✅ | 免审 |
| `read_image` | 文件 | 读 png/jpeg/gif/webp 为 vision block（magic-byte 嗅探，5MB 上限） | ✅ | 免审 |
| `ls` / `tree` | 文件 | 目录视图：ls 扁平按 mtime、tree 递归 | ✅ | 免审 |
| `glob` / `grep` | 文件 | 模式搜索（Rust regex / PCRE2） | ✅ | 免审 |
| `write` / `edit` | 文件 | 写 / 行锚点编辑；workspace 沙箱（`../` 逃逸即拒） | ❌ | 免审（工作区内=CC"工作目录编辑自动放行"先例） |
| `bash` | 执行 | shell；后台任务注册表 + 完成注入；可选 OS 沙箱（bwrap/Seatbelt，`bashSandbox` 显式开启，缺平台工具则 Run 装配失败） | ❌ | **门禁** |
| `eval` | 执行 | TS/JS 片段，`@chengchenccc/sandbox` 子进程；`timeout:0` = 无死线 | ❌ | **门禁** |
| `browser` | 执行 | headless Chromium（puppeteer-core，进程级共享浏览器 + 命名 tab）：`open/close/run`；run 以 AsyncFunction 执行 `tab` API（goto/observe/screenshot/click/type/fill/evaluate/…）；截图存 `.oma/screenshots` 并回传 vision block；run 超时杀 page 兜底 | ❌ | **门禁** |
| `web_search` / `web_fetch` | 网络 | DDG 搜索 / 带守卫的抓取（`disableWeb` 关闭） | ✅ | 免审 |
| `learn` | 记忆 | 显式记 lesson → `learned.md`（文件是真源）+ 向量索引双写（best-effort，索引失败文件层照赢） | ✅ | 免审 |
| `skill_load` | 会话 | 渐进加载 skill（skills/ 目录 SKILL.md 索引） | ✅ | 免审 |
| `todo_read` / `todo_write` | 会话 | workspace todo（`.oma/todo.json`，跨 Run 持久；状态归一化在 store） | 写 ❌ | 写 ❌（ask 下门禁） |
| `ask_question` | 会话 | HITL 问询：TUI 弹面板 / RPC 走命令；无管道时 fail-closed | ✅ | 免审 |
| `recall` | 记忆 | 混合检索 `.oma/memory/memory.db`（暴力 cosine + FTS5/LIKE → RRF 融合，veracity/时效加权；fastembed 本地 embedding，模型经 hf-mirror 预填缓存——上游 CDN 已死）；注入摘要截断时的第二召回面 | ❌ | 免审 |
| `retain` | 记忆 | 显式写一条可检索记忆（learn 是文件+索引双写，retain 只写索引） | ❌ | 免审 |
| `task` | 委派 | 子代理（硬隔离叶子：只有文件工具+按 access 的 bash/eval；0 层递归；支持 batch 与角色） | 按 access | 子代理**共享**主会话权限门 |
| `workflow_run` | 委派 | vm 沙箱 workflow 脚本（agent() 子代理） | 按 access | 同上 |
| `hub` | 协作 | 子代理/后台作业协调（TUI 跨 Run 句柄；backend 每 Run 新建） | — | — |
| `mcp__*` | 挂载 | workspace `.mcp.json` + 插件 MCP（逐 call timeout，进程树回收） | ✅ | **门禁**（product-tools/knowledge 前缀豁免） |

权限门禁三列的含义（见 [Oma 插件与 HITL](../plugins/oma-plugins.md)）：

- **门禁**（effect-escaping）：`bash` / `eval` / `browser` / `mcp__*` / 插件工具。ask=逐调用审批卡（`resolve_approval`，超时 deny）；auto=分类器逐调用审查（含关键路径删除硬熔断，classifier/人审都压不过它）；deny=直接 block。
- **免审**：读侧工具与工作区内写（write/edit 受路径沙箱约束，逃逸在工具层报错，不需审批）。
- `browser` 特有：read_only 不挂载（截图写工作区 + 驱动真实浏览器会话）。

## Context 文件（工具表之外，模型开局自带）

系统提示由 `core/settings/workspace-context.ts` 组装（`buildSystemPrompt` 的 `<workspace_context>` 块，**system role**，天然粘性）：

- `SOUL.md` / `USER.md`（cwd，oma 身份文件，平文在前）
- `<repo-rules>`：AGENTS.md 链——从 repo root（`.git` 边界）到 cwd 逐层，远的在前、cwd 最显著；用户级 `~/.oma/AGENTS.md` 收尾；字节相同的副本保留更显著者（omp context-files 语义，ponytail 裁剪：单约定、无 `@` imports）
- `<available_knowledge>`：`knowledge/index.md`（桥接生成的参考索引）
- `<dir-context>`：cwd 下一层子目录里未加载的 AGENTS.md 列为指针（改该目录前先读）

## 记忆（向量层）

`.oma/memory/memory.db`（bun:sqlite + FTS5，external-content 触发器同步）。写入路径：`learn` 双写、自动管线 facts 入库（source=autonomous）、`retain` 显式、首次打开时 learned.md 一次性回填（store 为空才跑）。读取路径：注入窗口（不变）+ `recall` 混合检索。卫生字段（veracity/recall_count/last_recalled/valid_until/superseded_by）第一天建表即在；superseded/expired/false 行任何声部都不出。knob：`.oma/settings.json` 的 `memoryVector: { enabled?, model? }`（standalone 默认开；product RPC 路径不挂）。模型默认 `intfloat/multilingual-e5-small`（384 维 int8，zh/en 混合），缓存于 `<agentDir>/models`，可用 `OMA_EMBEDDING_CACHE` 迁移。网络降级：模型获取失败时 FTS 声部照常应答且 recall 结果/`/memory` 标注 DEGRADED；HTTP 硬拒绝在缓存目录写 24h 负缓存标记（新进程秒断、不重付网络等待，超时类瞬态失败不标记），`OMA_EMBEDDINGS=off` 手动关断，测试经 bunfig preload 设 `OMA_VECTOR_MEMORY=0` 全局压制。

## 超时与预算

| 旋钮 | 默认 | 说明 |
|---|---|---|
| `maxSteps` / `maxForceContinues` | Run 级 | loop 步数上限（`.oma/settings.json` 的 `maxSteps` / env `OMA_MAX_STEPS`） |
| `modelTimeoutMs` | 120s | 单次模型 call（含 compaction summarizer）；超时 Run 失败，不静默重试 |
| `mcpTimeoutMs` | 120s | MCP 单 call（`withCallTimeout`；0 = 无死线） |
| `maxToolTimeoutMs` | — | 所有工具 per-call timeout 的全局上限 |
| `bashTimeoutMs` / `evalTimeoutMs` | 30s | 各自默认；bash `timeout:0` = 无死线 |
| `approvalTimeoutMs` | — | 审批卡等待；超时 fail-closed deny |

## 不变量

1. 工具表 per-Run 冻结；`--tools` 同时约束主会话与子代理表
2. read_only 集合：无 write/edit/bash/eval/browser；读侧与委派仍可用
3. effect-escaping 工具（bash/eval/browser/mcp__*/插件）必过权限门；write/edit 免审靠的是路径沙箱，不是信任
4. browser 是进程级单浏览器：Tab 注册表跨 Run 存活于 TUI 进程，backend 每 Run 一进程互不影响
5. MCP 命令在 spawn 前验证（PATH / 工作区相对 / 可执行位）；坏命令只挂掉自己的 server，报告带原因

## 关联页面

- [Oma Runtime](./oma.md)
- [Oma 插件与 HITL](../plugins/oma-plugins.md)
- [Compaction](./compaction.md)
